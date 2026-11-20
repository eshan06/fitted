import "@shopify/shopify-app-react-router/adapters/node";
import { randomUUID } from "node:crypto";
import { Session } from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import prisma from "./db.server";
import { resetCachedPlan } from "./models/billing.server";
import { checkJobs } from "./models/rules.server";
import {
  VERSION_LIMIT,
  listVersions,
  recordVersion,
} from "./models/chart-history.server";
import type { ChartInput } from "./models/chart.server";

// billing.server.ts imports it for plan checks, which nothing here runs. A
// resolve the job checks requeue finds no store: the offline session is
// refused at once, as a thrown Response is never retried. checkJobs acts on
// every shop in the database, so point these tests at the branch's own
// database (docs/GOTCHAS.md), never one npm run dev uses.
vi.mock("./shopify.server", () => ({
  unauthenticated: {
    admin: async () => {
      throw new Response(null, { status: 401 });
    },
  },
}));

// Runs against a real, migrated Postgres: CI's service container, or the docker
// compose one when DATABASE_URL is set (docs/GOTCHAS.md). CI never skips it.
const hasDatabase = Boolean(process.env.DATABASE_URL || process.env.CI);

const shops: string[] = [];
const newShop = () => {
  const shop = `db-test-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  return shop;
};

const offlineSession = (shop: string) =>
  new Session({
    id: `offline_${shop}`,
    shop,
    state: "state",
    isOnline: false,
    scope: "write_products,write_metaobjects",
    accessToken: "test-access-token",
    expires: new Date("2026-11-19T03:00:00.123Z"),
    refreshToken: "test-refresh-token",
    refreshTokenExpires: new Date("2027-02-17T03:00:00.456Z"),
  });

describe.runIf(hasDatabase)("the app database on Postgres", () => {
  // Built here, not in the describe body, so a skipped run never touches the database.
  let storage: PrismaSessionStorage<typeof prisma>;
  beforeAll(() => {
    storage = new PrismaSessionStorage(prisma);
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { shop: { in: shops } } });
    await prisma.shop.deleteMany({ where: { shop: { in: shops } } });
    await prisma.job.deleteMany({ where: { shop: { in: shops } } });
    await prisma.chartVersion.deleteMany({ where: { shop: { in: shops } } });
    await prisma.event.deleteMany({ where: { shop: { in: shops } } });
    await prisma.$disconnect();
  });

  it("is Postgres on Railway's major version, 18", async () => {
    const [{ version }] = await prisma.$queryRaw<{ version: string }[]>`
      SELECT current_setting('server_version_num') AS version`;

    expect(Math.floor(Number(version) / 10000)).toBe(18);
  });

  it("stores and loads an expiring offline session", async () => {
    const session = offlineSession(newShop());

    expect(await storage.storeSession(session)).toBe(true);

    expect((await storage.loadSession(session.id))?.toObject()).toEqual(
      session.toObject(),
    );
  });

  it("keeps an online session's staff member, with a user id past 32 bits", async () => {
    const shop = newShop();
    const staff = {
      id: 74299867353,
      first_name: "Priya",
      last_name: "Nair",
      email: "priya@example.com",
      email_verified: true,
      account_owner: false,
      locale: "en",
      collaborator: false,
    };
    const session = new Session({
      id: `${shop}_${staff.id}`,
      shop,
      state: "state",
      isOnline: true,
      scope: "write_products",
      accessToken: "test-online-token",
      expires: new Date("2026-11-20T03:00:00.000Z"),
      onlineAccessInfo: {
        expires_in: 86399,
        associated_user_scope: "write_products",
        associated_user: staff,
      },
    });

    await storage.storeSession(session);
    const loaded = await storage.loadSession(session.id);

    expect(loaded?.isOnline).toBe(true);
    expect(loaded?.expires).toEqual(session.expires);
    expect(loaded?.onlineAccessInfo?.associated_user).toEqual(staff);
  });

  it("finds and deletes only the given shop's sessions", async () => {
    const shop = newShop();
    const otherShop = newShop();
    await storage.storeSession(offlineSession(shop));
    await storage.storeSession(offlineSession(otherShop));

    expect(
      (await storage.findSessionsByShop(shop)).map((found) => found.id),
    ).toEqual([`offline_${shop}`]);

    // The query app/uninstalled runs.
    await prisma.session.deleteMany({ where: { shop } });

    expect(await storage.findSessionsByShop(shop)).toEqual([]);
    expect(await storage.loadSession(`offline_${otherShop}`)).toBeDefined();
  });

  it("keeps one plan cache row per shop, and app/uninstalled resets only that shop's to Free", async () => {
    const shop = newShop();
    const otherShop = newShop();
    const checkedAt = new Date("2026-11-19T03:00:00.123Z");
    // The writes app/models/billing.server.ts makes after each confirmed read.
    for (const [forShop, plan] of [
      [shop, "free"],
      [shop, "pro"],
      [otherShop, "standard"],
    ]) {
      const data = {
        plan,
        planYearly: plan === "pro",
        planCheckedAt: checkedAt,
        planOnStore: plan,
      };
      await prisma.shop.upsert({
        where: { shop: forShop },
        create: { shop: forShop, ...data },
        update: data,
      });
    }

    await resetCachedPlan(shop); // what app/uninstalled runs

    expect(await prisma.shop.findUnique({ where: { shop } })).toEqual({
      shop,
      plan: "free",
      planYearly: null,
      planCheckedAt: null,
      planOnStore: null,
      resolvedAt: null,
    });
    expect(
      await prisma.shop.findUnique({ where: { shop: otherShop } }),
    ).toEqual({
      shop: otherShop,
      plan: "standard",
      planYearly: false,
      planCheckedAt: checkedAt,
      planOnStore: "standard",
      resolvedAt: null,
    });
  });

  it("keeps each shop's jobs with their progress, and shop/redact deletes only that shop's", async () => {
    const shop = newShop();
    const otherShop = newShop();
    // The writes app/models/rules.server.ts makes as a resolve runs.
    for (const forShop of [shop, otherShop])
      await prisma.job.create({
        data: {
          id: randomUUID(),
          shop: forShop,
          kind: "resolve",
          status: "running",
          progress: { merchant: true, pass: 1 },
        },
      });
    const [job] = await prisma.job.findMany({ where: { shop } });
    const finished = await prisma.job.update({
      where: { id: job.id },
      data: { status: "done", result: { changed: 34 } },
    });

    expect(finished).toMatchObject({
      kind: "resolve",
      status: "done",
      progress: { merchant: true, pass: 1 },
      result: { changed: 34 },
      error: null,
    });
    expect(finished.updatedAt >= job.updatedAt).toBe(true);

    // The query shop/redact runs.
    await prisma.job.deleteMany({ where: { shop } });

    expect(await prisma.job.count({ where: { shop } })).toBe(0);
    expect(await prisma.job.count({ where: { shop: otherShop } })).toBe(1);
  });

  it("fails a job with no progress for 10 minutes and leaves one that moved since", async () => {
    const shop = newShop();
    const job = (minutes: number, status = "running") =>
      prisma.job.create({
        data: {
          id: randomUUID(),
          shop,
          kind: "import",
          status,
          updatedAt: new Date(Date.now() - minutes * 60_000),
        },
      });
    const stalled = await job(11);
    const moving = await job(9);
    const finished = await job(60, "done");

    await checkJobs();

    expect(
      await prisma.job.findUnique({ where: { id: stalled.id } }),
    ).toMatchObject({
      status: "failed",
      error: "The job stopped before it finished",
    });
    expect(
      await prisma.job.findUnique({ where: { id: moving.id } }),
    ).toMatchObject({ status: "running", error: null });
    expect(
      await prisma.job.findUnique({ where: { id: finished.id } }),
    ).toMatchObject({ status: "done", error: null });
  });

  it("requeues an installed shop's failed resolve as the same kind, three tries in all", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const shop = newShop();
    const uninstalled = newShop();
    const recovered = newShop();
    await storage.storeSession(offlineSession(shop));
    await storage.storeSession(offlineSession(recovered));
    const resolve = (forShop: string, status: string, minutes: number) =>
      prisma.job.create({
        data: {
          id: randomUUID(),
          shop: forShop,
          kind: "resolve",
          status,
          progress: { merchant: true, pass: 2 }, // from before attempts: the first
          createdAt: new Date(Date.now() - minutes * 60_000),
        },
      });
    await resolve(shop, "failed", 5);
    await resolve(uninstalled, "failed", 5);
    await resolve(recovered, "failed", 10);
    await resolve(recovered, "done", 5);

    // Each check waits for the resolve it requeued, which fails here.
    for (let i = 0; i < 3; i++) await checkJobs();

    const tries = await prisma.job.findMany({
      where: { shop },
      orderBy: { createdAt: "asc" },
    });
    expect(tries.map((j) => [j.status, j.progress])).toEqual([
      ["failed", { merchant: true, pass: 2 }],
      ["failed", { merchant: true, pass: 1, attempt: 2 }],
      ["failed", { merchant: true, pass: 1, attempt: 3 }],
    ]);
    expect(await prisma.job.count({ where: { shop: uninstalled } })).toBe(1);
    expect(await prisma.job.count({ where: { shop: recovered } })).toBe(2);
    logs.mockRestore();
  });

  const event = (shop: string, daysOld = 0) => ({
    shop,
    id: randomUUID(),
    type: "open",
    chartId: "gid://shopify/Metaobject/1301",
    productId: "gid://shopify/Product/8812",
    createdAt: new Date(Date.now() - daysOld * 86_400_000),
  });

  it("keeps one size guide event per shop and id, so a replay adds no row, and shop/redact deletes only that shop's", async () => {
    const shop = newShop();
    const otherShop = newShop();
    const first = { ...event(shop), size: null };
    // The write app/routes/proxy.events.tsx makes for each event.
    const record = (data: typeof first) =>
      prisma.event.createMany({ data, skipDuplicates: true });

    expect(await record(first)).toEqual({ count: 1 });
    // A replay, even one with another type, leaves the first as it was.
    expect(await record({ ...first, type: "add_to_cart" })).toEqual({
      count: 0,
    });
    // Another shop's event with that id is its own.
    expect(await record({ ...first, shop: otherShop })).toEqual({ count: 1 });
    expect(await prisma.event.findMany({ where: { shop } })).toEqual([first]);

    // The query shop/redact runs.
    await prisma.event.deleteMany({ where: { shop } });

    expect(await prisma.event.count({ where: { shop } })).toBe(0);
    expect(await prisma.event.count({ where: { shop: otherShop } })).toBe(1);
  });

  it("deletes size guide events over 90 days old with the job checks", async () => {
    const shop = newShop();
    const kept = [event(shop, 89), event(shop)];
    await prisma.event.createMany({ data: [...kept, event(shop, 91)] });

    await checkJobs();

    const left = await prisma.event.findMany({ where: { shop } });
    expect(left.map((e) => e.id).sort()).toEqual(kept.map((e) => e.id).sort());
  });

  it("deletes finished jobs over 7 days old but the newest finished one of each shop and kind", async () => {
    const shop = newShop();
    const otherShop = newShop();
    const job = async (
      forShop: string,
      kind: string,
      status: string,
      days: number,
    ) => {
      const createdAt = new Date(Date.now() - days * 86_400_000);
      const data = { id: randomUUID(), shop: forShop, kind, status, createdAt };
      return (await prisma.job.create({ data })).id;
    };
    const kept = [
      await job(shop, "resolve", "done", 2), // the newest finished resolve
      await job(shop, "resolve", "failed", 6), // under 7 days old
      await job(shop, "import", "done", 30), // the newest finished import
      await job(otherShop, "resolve", "done", 30), // newest finished, though
      await job(otherShop, "resolve", "running", 0), // a running one is newer
    ];
    await job(shop, "resolve", "done", 10);
    await job(shop, "resolve", "failed", 8);

    await checkJobs();

    const left = await prisma.job.findMany({
      where: { shop: { in: [shop, otherShop] } },
    });
    expect(left.map((j) => j.id).sort()).toEqual(kept.sort());
  });

  it("keeps each chart's last versions, newest first, within its shop", async () => {
    const shop = newShop();
    const otherShop = newShop();
    const id = "gid://shopify/Metaobject/1";
    const chart = (n: number) =>
      ({ name: `Chart ${n}` }) as unknown as ChartInput;
    expect(await recordVersion(otherShop, id, chart(0), "Jordan K.")).toBe(
      true,
    );
    for (let n = 1; n <= VERSION_LIMIT + 2; n++)
      await recordVersion(shop, id, chart(n), "Priya N.", `Save ${n}`);
    // The same chart again, from a retried save, adds nothing.
    await recordVersion(shop, id, chart(VERSION_LIMIT + 2), "Priya N.");

    const versions = await listVersions(shop, id);
    expect(versions).toHaveLength(VERSION_LIMIT);
    expect(versions[0]).toMatchObject({
      by: "Priya N.",
      summary: `Save ${VERSION_LIMIT + 2}`,
      snapshot: chart(VERSION_LIMIT + 2),
    });
    expect(versions[VERSION_LIMIT - 1].summary).toBe("Save 3");
    expect(await listVersions(otherShop, id)).toHaveLength(1);
    // Older versions are deleted, not only hidden.
    expect(
      await prisma.chartVersion.count({ where: { shop, chartId: id } }),
    ).toBe(VERSION_LIMIT);
    expect(versions[1].createdAt <= versions[0].createdAt).toBe(true);
  });

  it("summarizes a save against the version stored before it", async () => {
    const shop = newShop();
    const id = "gid://shopify/Metaobject/3";
    const chart = (bust: [number, number]): ChartInput => ({
      name: "Women's tops",
      template: "tops",
      content: {
        v: 1,
        unit: "in",
        roundTo: 0.5,
        tables: [
          {
            id: "t1",
            columns: [
              { id: "size", kind: "size" },
              { id: "bust", kind: "measure", convert: true },
            ],
            rows: [{ id: "m", cells: { bust } }],
          },
        ],
        measure: { steps: [] },
        words: { "t1.size": "Size", "t1.bust": "Bust", "t1.m.size": "M" },
      },
    });
    await recordVersion(shop, id, chart([35, 36]), "Priya N.");
    await recordVersion(shop, id, chart([35, 37]), "Jordan K.");

    expect(
      (await listVersions(shop, id)).map((v) => [v.by, v.summary]),
    ).toEqual([
      ["Jordan K.", "Bust for M changed"],
      ["Priya N.", "First saved version"],
    ]);
  });
});
