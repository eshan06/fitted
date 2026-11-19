import "@shopify/shopify-app-react-router/adapters/node";
import { randomUUID } from "node:crypto";
import { Session } from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import prisma from "./db.server";

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

  it("keeps one plan cache row per shop, and app/uninstalled clears only that shop's", async () => {
    const shop = newShop();
    const otherShop = newShop();
    const checkedAt = new Date("2026-11-19T03:00:00.123Z");
    // The writes app/models/billing.server.ts makes after each confirmed read.
    for (const [forShop, plan] of [
      [shop, "free"],
      [shop, "pro"],
      [otherShop, "standard"],
    ]) {
      const data = { plan, planCheckedAt: checkedAt, planOnStore: plan };
      await prisma.shop.upsert({
        where: { shop: forShop },
        create: { shop: forShop, ...data },
        update: data,
      });
    }

    // The query app/uninstalled runs.
    await prisma.shop.updateMany({
      where: { shop },
      data: { planOnStore: null, planCheckedAt: null },
    });

    expect(await prisma.shop.findUnique({ where: { shop } })).toEqual({
      shop,
      plan: "pro",
      planCheckedAt: null,
      planOnStore: null,
      resolvedAt: null,
    });
    expect(
      await prisma.shop.findUnique({ where: { shop: otherShop } }),
    ).toEqual({
      shop: otherShop,
      plan: "standard",
      planCheckedAt: checkedAt,
      planOnStore: "standard",
      resolvedAt: null,
    });
  });
});
