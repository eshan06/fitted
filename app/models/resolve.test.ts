import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Admin } from "./admin.server";

// The full resolve job (ARCHITECTURE §6, §13) against a fake store that runs
// bulk queries and bulk mutations the way Shopify does: a query's result file
// lists each product with the fields the query names, then each of its
// collections as its own line, and a mutation runs each line of the staged
// file as one atomic metafieldsSet. The job's two tables are kept in memory.
const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const jobs: Row[] = [];
  const shops = new Map<string, Row>();
  const db = {
    job: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        const now = new Date();
        const row = {
          progress: null,
          result: null,
          error: null,
          ...data,
          createdAt: now,
          updatedAt: now,
        };
        jobs.push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = jobs.find((j) =>
          Object.entries(where).every(([k, v]) => j[k] === v),
        );
        if (!row) throw new Error("Record to update not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      }),
    },
    shop: {
      upsert: vi.fn(
        async (q: { where: { shop: string }; create: Row; update: Row }) => {
          const row = shops.get(q.where.shop);
          shops.set(q.where.shop, row ? { ...row, ...q.update } : q.create);
          return shops.get(q.where.shop);
        },
      ),
    },
  };
  return { jobs, shops, db, admin: vi.fn() };
});
vi.mock("../db.server", () => ({ default: h.db }));
vi.mock("../shopify.server", () => ({ unauthenticated: { admin: h.admin } }));
import { type Rules, saveRules, startResolve } from "./rules.server";

const SHOP = "fitted-dev.myshopify.com";
const TYPE = "app--5512--chart";
const chart = (n: number) => `gid://shopify/Metaobject/${n}`;
const product = (n: number) => `gid://shopify/Product/${n}`;
const [SWIM, SLIM, BASIC] = [chart(1), chart(2), chart(3)];
const COL = "gid://shopify/Collection/21";

// Swimwear by tag (never product 2), slim fits by collection or metafield
// (applied only when the merchant asks), and a store default except gift cards.
const rules = (): Rules => ({
  v: 1,
  order: [SWIM, SLIM, BASIC],
  charts: {
    [SWIM]: {
      match: [{ field: "tag", op: "is", value: "swim" }],
      exclude: [{ field: "product", op: "is", ids: [product(2)] }],
      auto: true,
    },
    [SLIM]: {
      match: [
        { field: "collection", op: "is", ids: [COL] },
        {
          field: "metafield",
          key: "custom.fit",
          op: "contains",
          value: "slim",
        },
      ],
      exclude: [],
      auto: false,
    },
    [BASIC]: {
      match: [{ field: "all" }],
      exclude: [{ field: "vendor", op: "is", value: "Gift Co" }],
      auto: true,
    },
  },
});

type Fake = {
  tags?: string[];
  productType?: string;
  vendor?: string;
  collections?: string[];
  metafields?: Record<string, { type: string; value: string }>;
  chart?: string;
};
// Products 1 to 5 each test one rule; 6 to 35 fall to the store default, so
// assignments take two lines of a bulk mutation and removals two batches.
const catalog = (): [string, Fake][] => [
  [product(1), { tags: ["Swim"] }],
  [product(2), { tags: ["swim"] }],
  [product(3), { collections: ["gid://shopify/Collection/9", COL] }],
  [
    product(4),
    {
      metafields: {
        "custom.fit": {
          type: "list.single_line_text_field",
          value: JSON.stringify(["Regular", "Slim fit"]),
        },
      },
    },
  ],
  [product(5), { vendor: "Gift Co" }],
  ...Array.from({ length: 30 }, (_, i): [string, Fake] => [product(6 + i), {}]),
];
// What the rules give each product when the merchant asks.
const expected = () => ({
  [product(1)]: SWIM,
  [product(2)]: BASIC,
  [product(3)]: SLIM,
  [product(4)]: SLIM,
  [product(5)]: undefined,
  ...Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [product(6 + i), BASIC]),
  ),
});

const json = (body: unknown) => new Response(JSON.stringify(body));
// Result and staged files by URL, shared by every store like cloud storage.
const files = new Map<string, string>();
let seq = 0;
const fetchFake = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === "POST") {
    const form = init.body as FormData;
    // Shopify's storage reads the signed fields before the file.
    expect([...form.keys()].at(-1)).toBe("file");
    files.set(String(form.get("key")), await (form.get("file") as Blob).text());
    return new Response(null, { status: 201 });
  }
  const text = files.get(url);
  return text === undefined
    ? new Response("not found", { status: 404 })
    : new Response(text);
});

function fakeStore(shop = SHOP) {
  const products = new Map(catalog());
  // updatedAt defaults to the order charts were added, oldest first.
  const charts = new Map<string, { status: string; updatedAt?: number }>([
    [SWIM, { status: "ACTIVE" }],
    [SLIM, { status: "ACTIVE" }],
    [BASIC, { status: "ACTIVE" }],
  ]);
  let chartPages = 0;
  let stored: { value: string; digest: string } | null = null;
  const ops = new Map<
    string,
    { status: string; errorCode: string | null; url: string | null }
  >();
  const hooks: {
    // After a bulk read takes its snapshot: edits made here land after the read.
    afterRead?: (read: number) => void;
    // Polls that answer RUNNING before each bulk operation finishes.
    waits?: number;
    failRead?: string;
    refuse?: (ownerId: string, write: number) => boolean;
    // Mutation answers in input order without __lineNumber.
    unnumbered?: boolean;
    // After each page of the chart list, numbered across the job.
    afterChartPage?: (page: number) => void;
  } = {};
  let reads = 0;
  let writes = 0;
  const pending = new Map<string, number>();
  const calls: { name: string; variables: Record<string, unknown> }[] = [];

  const finish = (
    url: string | null,
    status = "COMPLETED",
    code: string | null = null,
  ) => {
    const id = `gid://shopify/BulkOperation/${++seq}`;
    ops.set(id, { status, errorCode: code, url });
    pending.set(id, hooks.waits ?? 0);
    return id;
  };
  const file = (lines: unknown[]) => {
    if (!lines.length) return null;
    const url = `https://storage.test/results/${++seq}.jsonl?signature=secret`;
    files.set(url, lines.map((l) => JSON.stringify(l)).join("\n"));
    return url;
  };
  // Reads every product with the fields the bulk query names.
  const read = (query: string) => {
    expect(query).toMatch(
      /^\{ products \{ edges \{ node \{ id tags productType vendor chart: metafield\(namespace: "\$app", key: "chart"\) \{ value \} /,
    );
    const aliases = [
      ...query.matchAll(
        /(m\d+): metafield\(namespace: "([\w-]+)", key: "([\w-]+)"\) \{ type value \}/g,
      ),
    ];
    const withCollections = query.includes(
      "collections { edges { node { id } } }",
    );
    return [...products].flatMap(([id, p]) => {
      const line: Record<string, unknown> = {
        id,
        tags: p.tags ?? [],
        productType: p.productType ?? "",
        vendor: p.vendor ?? "",
        chart: p.chart ? { value: p.chart } : null,
      };
      for (const [, alias, ns, key] of aliases)
        line[alias] = p.metafields?.[`${ns}.${key}`] ?? null;
      const children = withCollections ? (p.collections ?? []) : [];
      return [line, ...children.map((c) => ({ id: c, __parentId: id }))];
    });
  };
  // Runs each staged line as one metafieldsSet, all or nothing. The answers
  // come back in any order, numbered by __lineNumber.
  const write = (mutation: string, text: string) => {
    expect(mutation).toContain("metafieldsSet(metafields: $metafields)");
    writes++;
    const results = text.split("\n").map((l, i) => {
      const { metafields } = JSON.parse(l) as {
        metafields: Record<string, string>[];
      };
      expect(metafields.length).toBeLessThanOrEqual(25);
      const bad = metafields.filter(
        (m) =>
          !products.has(m.ownerId) ||
          m.namespace !== "$app" ||
          m.key !== "chart" ||
          m.type !== "metaobject_reference" ||
          !charts.has(m.value) ||
          hooks.refuse?.(m.ownerId, writes),
      );
      if (!bad.length)
        for (const m of metafields) products.get(m.ownerId)!.chart = m.value;
      const userErrors = bad.map((m) => ({
        field: ["metafields"],
        message: `Owner ${m.ownerId} can't be set`,
        code: "INVALID",
      }));
      return { data: { metafieldsSet: { userErrors } }, __lineNumber: i };
    });
    return hooks.unnumbered
      ? results.map(({ data }) => ({ data }))
      : results.reverse();
  };

  const graphql = vi.fn(
    async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const v = (opts?.variables ?? {}) as Record<string, never>;
      const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "";
      calls.push({ name, variables: v });
      switch (name) {
        case "FittedRules":
          return json({
            data: {
              shop: {
                id: "gid://shopify/Shop/1",
                rules: stored && {
                  jsonValue: JSON.parse(stored.value),
                  compareDigest: stored.digest,
                },
              },
            },
          });
        case "SaveRules": {
          const [input] = v.metafields as { value: string }[];
          stored = { value: input.value, digest: `d${++seq}` };
          return json({
            data: {
              metafieldsSet: {
                metafields: [{ compareDigest: stored.digest }],
                userErrors: [],
              },
            },
          });
        }
        case "ChartList": {
          // Fitted's charts, 50 a page, by id or newest saved first. Like
          // Shopify's, a cursor names the last chart sent, so a chart saved
          // between pages can move ahead of it in an updated_at listing.
          expect(query).toContain('metaobjects(type: "$app:chart", first: 50');
          expect(v.reverse).toBe(v.sortKey !== "id");
          const rank = (id: string, at: number) => {
            const n = Number(id.split("/").pop());
            return v.sortKey === "id" ? [n, 0] : [-at, -n];
          };
          const before = (a: number[], b: number[]) =>
            a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
          const sorted = [...charts]
            .map(([id, c], i) => ({ id, ...c, r: rank(id, c.updatedAt ?? i) }))
            .sort((a, b) => (before(a.r, b.r) ? -1 : 1));
          const cursor = v.after ? (JSON.parse(v.after) as number[]) : null;
          const rest = sorted.filter((c) => !cursor || before(cursor, c.r));
          const page = rest.slice(0, 50);
          const more = rest.length > 50;
          const nodes = page.map((c) => ({
            id: c.id,
            handle: `c-${c.id.slice(-10).padStart(10, "0")}`,
            type: TYPE,
            updatedAt: "2026-11-19T00:00:00Z",
            capabilities: { publishable: { status: c.status } },
            name: { value: "Chart" },
            template: null,
            content: null,
            measureImage: null,
            importNote: null,
          }));
          hooks.afterChartPage?.(++chartPages);
          const endCursor = more ? JSON.stringify(page.at(-1)!.r) : null;
          return json({
            data: {
              metaobjects: {
                nodes,
                pageInfo: { hasNextPage: more, endCursor },
              },
            },
          });
        }
        case "ResolveRead": {
          const lines = read(v.query);
          hooks.afterRead?.(++reads);
          const id = hooks.failRead
            ? finish(null, "FAILED", hooks.failRead)
            : finish(file(lines));
          return json({
            data: {
              bulkOperationRunQuery: { bulkOperation: { id }, userErrors: [] },
            },
          });
        }
        case "ResolveStage":
          return json({
            data: {
              stagedUploadsCreate: {
                stagedTargets: [
                  {
                    url: "https://storage.test/uploads?signature=secret",
                    parameters: [
                      { name: "key", value: `tmp/bulk/${++seq}/charts.jsonl` },
                      { name: "policy", value: "signed" },
                    ],
                  },
                ],
                userErrors: [],
              },
            },
          });
        case "ResolveWrite": {
          const text = files.get(v.path);
          expect(text).toBeDefined();
          const id = finish(file(write(v.mutation, text!)));
          return json({
            data: {
              bulkOperationRunMutation: {
                bulkOperation: { id },
                userErrors: [],
              },
            },
          });
        }
        case "ResolveWait": {
          const op = ops.get(v.id)!;
          const left = pending.get(v.id) ?? 0;
          pending.set(v.id, left - 1);
          return json({
            data: {
              bulkOperation:
                left > 0
                  ? { status: "RUNNING", errorCode: null, url: null }
                  : op,
            },
          });
        }
        case "ResolveRemove": {
          const ids = v.metafields as { ownerId: string; key: string }[];
          expect(ids.length).toBeLessThanOrEqual(25);
          const deletedMetafields = ids.map((m) => {
            const p = products.get(m.ownerId);
            if (!p?.chart || m.key !== "chart") return null;
            delete p.chart;
            return { ownerId: m.ownerId };
          });
          return json({
            data: { metafieldsDelete: { deletedMetafields, userErrors: [] } },
          });
        }
      }
      throw new Error(`The fake store doesn't know ${name}`);
    },
  );
  const admin = { graphql } as unknown as Admin;
  stores.set(shop, admin);
  return {
    admin,
    products,
    charts,
    hooks,
    calls,
    named: (n: string) => calls.filter((c) => c.name === n),
    assigned: () =>
      Object.fromEntries([...products].map(([id, p]) => [id, p.chart])),
    setRules: (r: unknown) =>
      (stored = { value: JSON.stringify(r), digest: `d${++seq}` }),
    writes: () => writes,
  };
}
const stores = new Map<string, Admin>();

let logs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  h.jobs.length = 0;
  h.shops.clear();
  files.clear();
  stores.clear();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => logs.push(line));
  vi.stubGlobal("fetch", fetchFake);
  h.admin.mockImplementation(async (shop: string) => ({
    admin: stores.get(shop),
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The job rows, oldest first, without their timestamps.
const jobs = () =>
  h.jobs.map(({ shop, kind, status, progress, result, error }) => ({
    shop,
    kind,
    status,
    progress,
    result,
    error,
  }));
const done = (merchant: boolean, changed: number) => ({
  shop: SHOP,
  kind: "resolve",
  status: "done",
  progress: { merchant, pass: 2 },
  result: { changed },
  error: null,
});
const failed = (merchant: boolean, error: string) => ({
  shop: SHOP,
  kind: "resolve",
  status: "failed",
  progress: expect.objectContaining({ merchant }),
  result: null,
  error,
});

describe("a full resolve", () => {
  it("moves every product onto its chart after a rules save, in one bulk mutation of 25 a line", async () => {
    const store = fakeStore();
    await saveRules(store.admin, rules(), null, "pro");
    const saveCalls = store.calls.length;

    await startResolve(SHOP, true);

    expect(store.assigned()).toEqual(expected());
    expect(jobs()).toEqual([done(true, 34)]);
    // The offline session is loaded for every call, and each job write names the shop.
    expect(h.admin).toHaveBeenCalledTimes(store.calls.length - saveCalls);
    expect(h.admin.mock.calls.every(([s]) => s === SHOP)).toBe(true);
    expect(
      h.db.job.update.mock.calls.every(([q]) => q.where.shop === SHOP),
    ).toBe(true);
    // One staged file of two lines (25 and 9) in the first pass; the second pass finds nothing to change.
    expect(store.writes()).toBe(1);
    const staged = [...files.entries()].find(([k]) => k.startsWith("tmp/"));
    expect(
      staged![1].split("\n").map((l) => JSON.parse(l).metafields.length),
    ).toEqual([25, 9]);
    expect(store.named("ResolveRemove")).toEqual([]);
    // The query reads the compared metafield and, since a rule names one, collections.
    const query = String(store.named("ResolveRead")[0].variables.query);
    expect(query).toContain(
      'm0: metafield(namespace: "custom", key: "fit") { type value }',
    );
    expect(query).toContain("collections { edges { node { id } } }");
    expect(h.shops.get(SHOP)).toMatchObject({
      plan: "free",
      resolvedAt: expect.any(Date),
    });
    expect(JSON.parse(logs.at(-1)!)).toEqual({
      level: "info",
      msg: "Display rules applied",
      shop: SHOP,
      route: "resolve",
      changed: 34,
    });
  });

  it("moves a Draft chart's products to their next match and removes charts nothing matches, 25 at a time", async () => {
    const store = fakeStore();
    store.setRules(rules());
    await startResolve(SHOP, true);
    store.charts.set(BASIC, { status: "DRAFT" });
    store.charts.set(SWIM, { status: "DRAFT" });
    h.db.job.update.mockClear();

    await startResolve(SHOP, true);

    // A touch as each pass starts and after each batch of removals.
    const touches = h.db.job.update.mock.calls.filter(
      ([q]) => !("status" in q.data),
    );
    expect(touches).toHaveLength(2 + 2);
    // Product 1 had nothing after swimwear; the store default's 31 go too.
    expect(store.assigned()).toEqual({
      ...Object.fromEntries(
        [...store.products.keys()].map((id) => [id, undefined]),
      ),
      [product(3)]: SLIM,
      [product(4)]: SLIM,
    });
    expect(
      store
        .named("ResolveRemove")
        .map((c) => (c.variables.metafields as []).length),
    ).toEqual([25, 7]);
    expect(store.named("ResolveRemove")[0].variables.metafields).toContainEqual(
      {
        ownerId: product(1),
        namespace: "$app",
        key: "chart",
      },
    );
    expect(jobs()[1]).toEqual(done(true, 32));
  });

  it("finds Active charts on every page of the chart list, skipping ranked ids that aren't charts", async () => {
    const store = fakeStore();
    const [GONE, DRAFT, LATE] = [chart(100), chart(101), chart(160)];
    for (let n = 101; n < 160; n++)
      store.charts.set(chart(n), { status: "DRAFT" });
    store.charts.set(LATE, { status: "ACTIVE" });
    const all = { match: [{ field: "all" as const }], exclude: [], auto: true };
    store.setRules({
      v: 1,
      order: [GONE, DRAFT, LATE, BASIC],
      charts: { [GONE]: all, [DRAFT]: all, [LATE]: all, [BASIC]: all },
    });

    await startResolve(SHOP, true);

    // The 63rd chart, on the second page, outranks the store default.
    expect(new Set(Object.values(store.assigned()))).toEqual(new Set([LATE]));
    // Two pages in each pass, the second after chart 147, the 50th by id.
    expect(store.named("ChartList").map((c) => c.variables.after)).toEqual([
      null,
      "[147,0]",
      null,
      "[147,0]",
    ]);
  });

  it("never misses an Active chart saved while the chart list is read", async () => {
    const store = fakeStore();
    const LATE = chart(160);
    for (let n = 101; n < 160; n++)
      store.charts.set(chart(n), { status: "DRAFT" });
    // Saved longest ago, so it sits on the last page of an updated_at listing.
    store.charts.set(LATE, { status: "ACTIVE", updatedAt: -1 });
    const all = { match: [{ field: "all" as const }], exclude: [], auto: true };
    store.setRules({
      v: 1,
      order: [LATE, BASIC],
      charts: { [LATE]: all, [BASIC]: all },
    });
    // The merchant saves it between the second pass's two pages.
    store.hooks.afterChartPage = (page) => {
      if (page === 3) store.charts.get(LATE)!.updatedAt = 1000;
    };

    await startResolve(SHOP, true);

    expect(new Set(Object.values(store.assigned()))).toEqual(new Set([LATE]));
    expect(jobs()).toEqual([done(true, 35)]);
  });

  it("writes nothing when every product already shows its chart", async () => {
    const store = fakeStore();
    store.setRules(rules());
    await startResolve(SHOP, true);
    const before = store.calls.length;

    await startResolve(SHOP, true);

    const names = store.calls.slice(before).map((c) => c.name);
    expect(names).not.toContain("ResolveStage");
    expect(names).not.toContain("ResolveWrite");
    expect(names).not.toContain("ResolveRemove");
    expect(jobs()[1]).toEqual(done(true, 0));
  });

  it("leaves auto: false charts to resolves the merchant causes", async () => {
    const store = fakeStore();
    store.setRules(rules());
    store.products.get(product(3))!.chart = SLIM;
    store.products.get(product(3))!.collections = [];

    await startResolve(SHOP, false);

    // Product 3 keeps its slim chart though nothing matches it now; product 4
    // matches the slim chart but gets the next one instead.
    expect(store.assigned()).toMatchObject({
      [product(3)]: SLIM,
      [product(4)]: BASIC,
    });
    expect(jobs()).toEqual([done(false, 33)]);

    await startResolve(SHOP, true);

    expect(store.assigned()).toMatchObject({
      [product(3)]: BASIC,
      [product(4)]: SLIM,
    });
  });

  it("compares each item of a list metafield, and reads collections only when a rule names one", async () => {
    const store = fakeStore();
    const text = (value: string) => ({ type: "single_line_text_field", value });
    const list = (type: string, items: unknown[]) => ({
      type: `list.${type}`,
      value: JSON.stringify(items),
    });
    const mf = (key: string, value: string) =>
      ({ field: "metafield", key, op: "is", value }) as const;
    store.products.get(product(7))!.metafields = {
      "custom.season": text(" Summer "),
      "custom.fit": list("single_line_text_field", ["Regular", "Slim"]),
    };
    store.products.get(product(8))!.metafields = {
      "custom.season": text("summer"),
      "custom.fit": list("single_line_text_field", ["Wide"]),
    };
    store.products.get(product(9))!.metafields = {
      "custom.sizes": list("number_integer", [32, 34]),
    };
    store.setRules({
      v: 1,
      order: [SLIM],
      charts: {
        [SLIM]: {
          match: [mf("custom.season", "summer"), mf("custom.sizes", "34")],
          exclude: [mf("custom.fit", "wide")],
          auto: true,
        },
      },
    });

    await startResolve(SHOP, false);

    expect(Object.entries(store.assigned()).filter(([, c]) => c)).toEqual([
      [product(7), SLIM],
      [product(9), SLIM],
    ]);
    const query = String(store.named("ResolveRead")[0].variables.query);
    expect(query).toContain(
      'm0: metafield(namespace: "custom", key: "season")',
    );
    expect(query).toContain('m2: metafield(namespace: "custom", key: "fit")');
    expect(query).not.toContain("collections");
  });

  it("catches in its second pass a product edited during the first, and records each pass's start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-19T06:00:00Z");
    vi.setSystemTime(start);
    const store = fakeStore();
    store.setRules(rules());
    store.hooks.afterRead = (read) => {
      // After the first read took its snapshot.
      if (read === 1) store.products.get(product(5))!.vendor = "Acme";
      vi.setSystemTime(start.getTime() + read * 60_000);
    };

    await startResolve(SHOP, true);

    expect(store.assigned()[product(5)]).toBe(BASIC);
    expect(jobs()).toEqual([done(true, 35)]);
    // Each pass records its start once it has applied every change it found.
    expect(
      h.db.shop.upsert.mock.calls.map(([q]) => q.update.resolvedAt),
    ).toEqual([start, new Date(start.getTime() + 60_000)]);
    expect(h.shops.get(SHOP)?.resolvedAt).toEqual(
      new Date(start.getTime() + 60_000),
    );
  });
});

describe("one resolve per shop at a time", () => {
  it("runs once more when asked while running, as a merchant resolve if any ask was", async () => {
    const store = fakeStore();
    const other = fakeStore("other.myshopify.com");
    store.setRules(rules());
    other.setRules(rules());
    let asks: Promise<void>[] = [];
    let jobsAtAsk: unknown[] = [];
    store.hooks.afterRead = (read) => {
      if (read !== 1) return;
      jobsAtAsk = h.jobs.map((j) => j.shop);
      asks = [
        startResolve(SHOP, false),
        startResolve(SHOP, true),
        startResolve(SHOP, false),
      ];
    };

    const first = startResolve(SHOP, false);
    const parallel = startResolve("other.myshopify.com", false);
    await first;
    await parallel;

    // One job for this shop while it ran; the other shop's ran alongside it.
    expect(jobsAtAsk).toEqual([SHOP, "other.myshopify.com"]);
    for (const ask of asks) expect(ask).toBe(first);
    expect(jobs().filter((j) => j.shop === SHOP)).toEqual([
      done(false, 34),
      done(true, 2),
    ]);
    expect(store.assigned()).toEqual(expected());
    expect(other.assigned()[product(3)]).toBe(BASIC);
  });
});

describe("a failed resolve", () => {
  it("is recorded on the job and logged, leaving products as they were", async () => {
    const store = fakeStore();
    store.setRules(rules());
    store.hooks.failRead = "INTERNAL_SERVER_ERROR";

    await startResolve(SHOP, true);

    expect(store.assigned()).toEqual(
      Object.fromEntries(
        [...store.products.keys()].map((id) => [id, undefined]),
      ),
    );
    expect(jobs()).toEqual([
      failed(true, "Shopify's bulk operation didn't finish"),
    ]);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      level: "error",
      msg: "Display rules didn't finish applying",
      shop: SHOP,
      route: "resolve",
      detail: "FAILED INTERNAL_SERVER_ERROR",
    });
    expect(h.shops.has(SHOP)).toBe(false);
  });

  it("stops before reading products when the saved rules fail validation, rather than unassigning them all", async () => {
    const store = fakeStore();
    store.setRules({ v: 1, order: [SWIM], charts: {} });
    store.products.get(product(1))!.chart = SWIM;

    await startResolve(SHOP, true);

    expect(jobs()).toEqual([
      failed(true, "The saved display rules can't be read"),
    ]);
    expect(store.named("ResolveRead")).toEqual([]);
    expect(store.assigned()[product(1)]).toBe(SWIM);
  });

  it("redoes in the second pass the lines Shopify refused in the first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-19T06:00:00Z");
    vi.setSystemTime(start);
    const store = fakeStore();
    store.setRules(rules());
    store.hooks.refuse = (owner, write) => owner === product(7) && write === 1;
    store.hooks.afterRead = (read) =>
      vi.setSystemTime(start.getTime() + read * 60_000);

    await startResolve(SHOP, true);

    expect(store.assigned()).toEqual(expected());
    expect(store.writes()).toBe(2);
    expect(jobs()).toEqual([done(true, 34)]);
    // Shopify's reason is logged; only the second pass, which set everything, records its start.
    expect(JSON.parse(logs[0])).toMatchObject({
      level: "warn",
      msg: "Shopify refused the chart for 25 products",
      detail: expect.stringContaining(`Owner ${product(7)} can't be set`),
    });
    expect(h.db.shop.upsert).toHaveBeenCalledOnce();
    expect(h.shops.get(SHOP)?.resolvedAt).toEqual(
      new Date(start.getTime() + 60_000),
    );
  });

  it("fails when Shopify still refuses charts in the second pass", async () => {
    const store = fakeStore();
    store.setRules(rules());
    store.hooks.refuse = (owner) => owner === product(7);

    await startResolve(SHOP, true);

    // The refused line held 25 products, product 7 among them.
    expect(jobs()).toEqual([
      failed(true, "Shopify refused the chart for 25 products"),
    ]);
    expect(store.assigned()[product(7)]).toBeUndefined();
    expect(JSON.parse(logs.at(-1)!).detail).toContain(
      `Owner ${product(7)} can't be set`,
    );
    expect(h.shops.has(SHOP)).toBe(false);
  });

  it("finishes with nothing to do when the store has no products", async () => {
    const store = fakeStore();
    store.setRules(rules());
    store.products.clear();

    await startResolve(SHOP, true);

    expect(jobs()).toEqual([done(true, 0)]);
    expect(store.named("ResolveWrite")).toEqual([]);
  });

  it("records an unexpected failure as one, without its text", async () => {
    const store = fakeStore();
    store.setRules(rules());
    h.db.shop.upsert.mockRejectedValueOnce(new Error("lost connection"));

    await startResolve(SHOP, true);

    expect(jobs()).toEqual([failed(true, "Something went wrong")]);
    expect(JSON.parse(logs.at(-1)!).error).toContain("lost connection");
  });

  it("fails when a bulk file doesn't transfer, never logging its signed URL", async () => {
    const store = fakeStore();
    store.setRules(rules());
    fetchFake.mockImplementationOnce(
      async () => new Response("denied", { status: 403 }),
    );
    await startResolve(SHOP, true);
    // A fetch that fails outright may name the URL in its message.
    fetchFake.mockImplementationOnce(async (url: string) => {
      throw new TypeError(`Failed to parse URL from ${url}`);
    });
    await startResolve(SHOP, true);

    expect(jobs()).toEqual([
      failed(true, "Shopify's bulk file didn't transfer"),
      failed(true, "Shopify's bulk file didn't transfer"),
    ]);
    expect(logs.map((l) => JSON.parse(l).detail)).toEqual([
      "HTTP 403",
      "TypeError",
    ]);
    expect(logs.join("\n")).not.toContain("signature");
  });

  it("counts mutation answers by position when they come without line numbers", async () => {
    const store = fakeStore();
    store.setRules(rules());
    store.hooks.unnumbered = true;
    // Product 30 sits in the first pass's second line, of 9.
    store.hooks.refuse = (owner, write) => owner === product(30) && write === 1;

    await startResolve(SHOP, true);

    expect(store.writes()).toBe(2);
    expect(store.assigned()).toEqual(expected());
    expect(jobs()).toEqual([done(true, 34)]);
  });

  it("is never thrown at the caller, even when the job can't be recorded", async () => {
    fakeStore().setRules(rules());
    h.db.job.create.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(startResolve(SHOP, true)).resolves.toBeUndefined();
    expect(JSON.parse(logs.at(-1)!).error).toContain("database unavailable");

    const store = fakeStore();
    store.setRules(rules());
    store.hooks.failRead = "INTERNAL_SERVER_ERROR";
    h.db.job.update
      .mockImplementationOnce(async () => ({}))
      .mockRejectedValueOnce(new Error("database unavailable"));
    await expect(startResolve(SHOP, true)).resolves.toBeUndefined();
    expect(JSON.parse(logs.at(-1)!).msg).toBe("Resolve failure not recorded");
  });
});

describe("waiting on bulk operations", () => {
  // Moves the fake clock a poll at a time until the job settles.
  const settle = async (job: Promise<void>) => {
    let over = false;
    void job.then(() => (over = true));
    while (!over) await vi.advanceTimersByTimeAsync(3000);
  };

  it("polls a running operation, touching the job so it never looks stalled", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    store.setRules(rules());
    store.hooks.waits = 2;

    await settle(startResolve(SHOP, true));

    expect(store.assigned()).toEqual(expected());
    // Two RUNNING answers for each of three bulk operations (two reads, one write).
    expect(store.named("ResolveWait")).toHaveLength(9);
    // A touch as each pass starts and after each RUNNING answer.
    const touches = h.db.job.update.mock.calls.filter(
      ([q]) => !("status" in q.data),
    );
    expect(touches).toHaveLength(2 + 6);
    expect(jobs()).toEqual([done(true, 34)]);
  });

  it("gives up on an operation still running after 2 hours", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    store.setRules(rules());
    store.hooks.waits = Infinity;

    await settle(startResolve(SHOP, true));

    expect(jobs()).toEqual([
      failed(true, "Shopify's bulk operation took too long"),
    ]);
    expect(store.named("ResolveWait").length).toBeGreaterThan(2000);
  });
});
