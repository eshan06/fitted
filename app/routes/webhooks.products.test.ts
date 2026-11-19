import { createHmac } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { action as collections } from "./webhooks.collections";
import { action as products } from "./webhooks.products";

// The webhooks that keep products on their charts (ARCHITECTURE §6, §16),
// through the real authenticate.webhook, so every delivery's signature is
// checked with the app's secret, and the real rules model. Only the database
// and the store's Admin API are faked: one Active swimwear chart, for tagged
// products and those in collection 21, and an empty catalog for full resolves.
const h = vi.hoisted(() => {
  const secret = "test-api-secret";
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = secret;
  process.env.SHOPIFY_APP_URL = "https://fitted.test";
  const db = {
    // `count` is the session storage's startup check.
    session: { count: vi.fn(), findUnique: vi.fn() },
    shop: { findUnique: vi.fn(), upsert: vi.fn() },
    job: {
      create: vi.fn(async ({ data }: { data: object }) => data),
      update: vi.fn(async (q: { data: { status?: string } }) => q),
    },
  };
  return { secret, db, graphql: vi.fn() };
});
vi.mock("../db.server", () => ({ default: h.db }));
vi.mock("../shopify.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shopify.server")>()),
  unauthenticated: { admin: async () => ({ admin: { graphql: h.graphql } }) },
}));

const shop = "fitted-test.myshopify.com";
const SWIM = "gid://shopify/Metaobject/1";
const TYPE = "app--5512--chart";
const rules = {
  v: 1,
  order: [SWIM],
  charts: {
    [SWIM]: {
      match: [
        { field: "tag", op: "is", value: "swim" },
        { field: "collection", op: "is", ids: ["gid://shopify/Collection/21"] },
      ],
      exclude: [],
      auto: true,
    },
  },
};
let chart: string | null; // product 7's chart in the store
let refuse: boolean; // Shopify refuses to set it
// Each operation's answer, from its variables.
const answers: Record<string, (v: never) => unknown> = {
  FittedRules: () => ({
    shop: {
      id: "gid://shopify/Shop/1",
      rules: { jsonValue: rules, compareDigest: "d1" },
    },
  }),
  ResolveOne: (v: { id: string }) => ({
    product: {
      id: v.id,
      tags: ["swim"],
      productType: "",
      vendor: "",
      chart: chart && { value: chart },
      collections: { nodes: [] },
    },
    charts: [
      {
        id: SWIM,
        type: TYPE,
        capabilities: { publishable: { status: "ACTIVE" } },
      },
    ],
    definition: { type: TYPE },
  }),
  ResolveSet: (v: { metafields: { value: string }[] }) => {
    if (!refuse) chart = v.metafields[0].value;
    const userErrors = refuse
      ? [
          {
            field: ["metafields"],
            message: "Too many requests",
            code: "THROTTLED",
          },
        ]
      : [];
    return { metafieldsSet: { userErrors } };
  },
  ChartList: () => ({
    metaobjects: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  }),
  ResolveRead: () => ({
    bulkOperationRunQuery: {
      bulkOperation: { id: "gid://shopify/BulkOperation/1" },
      userErrors: [],
    },
  }),
  ResolveWait: () => ({
    bulkOperation: { status: "COMPLETED", errorCode: null, url: null },
  }),
};
// The Admin API calls made, by operation name.
const calls = () =>
  h.graphql.mock.calls.map(([q]) => /(?:query|mutation) (\w+)/.exec(q)?.[1]);

type Action = (args: ActionFunctionArgs) => Promise<Response>;
/** Answers as the route would: a Response the library throws is the reply. */
const deliver = (
  action: Action,
  topic: string,
  payload: unknown,
  { signedWith = h.secret, signed = true } = {},
) => {
  const body = JSON.stringify(payload);
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Shopify-Topic": topic,
    "X-Shopify-Shop-Domain": shop,
    "X-Shopify-API-Version": "2027-01",
    "X-Shopify-Webhook-Id": "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
  });
  if (signed) {
    const hmac = createHmac("sha256", signedWith).update(body).digest("base64");
    headers.set("X-Shopify-Hmac-Sha256", hmac);
  }
  const request = new Request(`https://fitted.test/webhooks/${topic}`, {
    method: "POST",
    headers,
    body,
  });
  return action({ request } as ActionFunctionArgs).catch((thrown: unknown) => {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  });
};

/** The shop's offline session as the database holds it, its token still good. */
const storedSession = {
  id: `offline_${shop}`,
  shop,
  state: "",
  isOnline: false,
  scope: "write_products",
  expires: new Date(Date.now() + 60 * 60_000),
  accessToken: "test-access-token",
  userId: null,
  firstName: null,
  lastName: null,
  email: null,
  accountOwner: false,
  locale: null,
  collaborator: false,
  emailVerified: false,
  refreshToken: "test-refresh-token",
  refreshTokenExpires: new Date(Date.now() + 90 * 86_400_000),
};
const edited = { id: 7, updated_at: "2026-11-19T10:15:42-05:00" };

let logs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  chart = null;
  refuse = false;
  h.db.session.findUnique.mockResolvedValue(storedSession);
  h.db.shop.findUnique.mockResolvedValue(null);
  h.graphql.mockImplementation(
    async (query: string, opts?: { variables?: object }) => {
      const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? "";
      const data = answers[name]((opts?.variables ?? {}) as never);
      return new Response(JSON.stringify({ data }));
    },
  );
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => logs.push(line));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([
  ["products/update", products, edited],
  [
    "collections/update",
    collections,
    { id: 21, updated_at: edited.updated_at },
  ],
] as const)("the %s webhook", (topic, action, payload) => {
  it.each([
    ["signed with another secret", { signedWith: "not-the-app-secret" }, 401],
    ["unsigned", { signed: false }, 400],
  ])(
    "refuses a delivery %s, before any query or call to Shopify",
    async (_, options, status) => {
      expect((await deliver(action, topic, payload, options)).status).toBe(
        status,
      );

      expect(h.db.session.findUnique).not.toHaveBeenCalled();
      expect(h.graphql).not.toHaveBeenCalled();
    },
  );

  it("answers 200 and calls Shopify for nothing when the shop has no session, as after an uninstall", async () => {
    h.db.session.findUnique.mockResolvedValue(null);

    expect((await deliver(action, topic, payload)).status).toBe(200);

    expect(h.graphql).not.toHaveBeenCalled();
  });
});

describe("the products/create and products/update webhook", () => {
  it.each(["products/create", "products/update"])(
    "gives the product of a %s delivery its chart and answers 200",
    async (topic) => {
      expect((await deliver(products, topic, edited)).status).toBe(200);

      expect(chart).toBe(SWIM);
      expect(calls()).toEqual(["FittedRules", "ResolveOne", "ResolveSet"]);
      expect(h.graphql.mock.calls[1][1].variables).toEqual({
        id: "gid://shopify/Product/7",
        charts: [SWIM],
      });
    },
  );

  it("answers Shopify's repeat of a delivery with 200 and writes nothing more", async () => {
    await deliver(products, "products/update", edited);

    expect((await deliver(products, "products/update", edited)).status).toBe(
      200,
    );

    expect(calls()).toEqual([
      "FittedRules",
      "ResolveOne",
      "ResolveSet",
      "FittedRules",
      "ResolveOne",
    ]);
  });

  it("answers 200 without a call to Shopify for an edit the last full resolve read", async () => {
    // The pass began a minute after the edit (15:15:42 UTC).
    h.db.shop.findUnique.mockResolvedValue({
      resolvedAt: new Date("2026-11-19T15:16:42Z"),
    });

    expect((await deliver(products, "products/update", edited)).status).toBe(
      200,
    );

    expect(h.graphql).not.toHaveBeenCalled();
  });

  it.each([
    ["no id", { updated_at: edited.updated_at }],
    ["an id that isn't a number", { ...edited, id: "7" }],
    ["an id of 0", { ...edited, id: 0 }],
    ["a negative id", { ...edited, id: -7 }],
    ["an id too large to read exactly", { ...edited, id: 2 ** 53 }],
    ["no updated_at", { id: 7 }],
    ["an updated_at of null", { id: 7, updated_at: null }],
    ["an updated_at that isn't a time", { id: 7, updated_at: "yesterday" }],
  ])(
    "answers 400 to a payload with %s, calling Shopify for nothing",
    async (_, payload) => {
      expect((await deliver(products, "products/update", payload)).status).toBe(
        400,
      );

      expect(h.graphql).not.toHaveBeenCalled();
      expect(JSON.parse(logs.at(-1)!)).toEqual({
        level: "warn",
        msg: "Product webhook without a product id and updated_at",
        shop,
        route: "webhooks/products",
      });
    },
  );

  it("answers 500 when Shopify refuses the chart, so Shopify sends it again", async () => {
    refuse = true;

    expect((await deliver(products, "products/update", edited)).status).toBe(
      500,
    );

    expect(chart).toBeNull();
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      level: "error",
      msg: "Product chart didn't finish",
      shop,
      productId: "gid://shopify/Product/7",
    });
  });
});

describe("the collections/update and collections/delete webhook", () => {
  it.each(["collections/update", "collections/delete"])(
    "starts a resolve, not the merchant's, when a rule names the collection of a %s delivery",
    async (topic) => {
      expect((await deliver(collections, topic, { id: 21 })).status).toBe(200);

      expect(h.db.job.create).toHaveBeenCalledExactlyOnceWith({
        data: expect.objectContaining({
          shop,
          kind: "resolve",
          status: "running",
          progress: { merchant: false, pass: 1 },
        }),
      });
      // It runs after the answer, over this store's empty catalog.
      await vi.waitFor(() =>
        expect(h.db.job.update).toHaveBeenLastCalledWith({
          where: expect.objectContaining({ shop }),
          data: { status: "done", result: { changed: 0 } },
        }),
      );
    },
  );

  it("answers Shopify's repeat of a delivery with 200, resolving once more", async () => {
    const delivery = { id: 21, updated_at: edited.updated_at };

    for (let i = 0; i < 2; i++)
      expect(
        (await deliver(collections, "collections/update", delivery)).status,
      ).toBe(200);

    // A repeat while the first runs makes it run once more; after, it starts
    // another. Either way two resolves, each finishing.
    await vi.waitFor(() =>
      expect(
        h.db.job.update.mock.calls.filter(([q]) => q.data.status === "done"),
      ).toHaveLength(2),
    );
    expect(h.db.job.create).toHaveBeenCalledTimes(2);
  });

  it("only reads the rules when none names the collection", async () => {
    expect(
      (await deliver(collections, "collections/update", { id: 22 })).status,
    ).toBe(200);

    expect(calls()).toEqual(["FittedRules"]);
    expect(h.db.job.create).not.toHaveBeenCalled();
  });

  it.each([
    ["no id", {}],
    ["an id that isn't a number", { id: "21" }],
    ["an id of 0", { id: 0 }],
    ["a negative id", { id: -21 }],
    ["an id too large to read exactly", { id: 2 ** 53 }],
  ])(
    "answers 400 to a payload with %s, calling Shopify for nothing",
    async (_, payload) => {
      expect(
        (await deliver(collections, "collections/update", payload)).status,
      ).toBe(400);

      expect(h.graphql).not.toHaveBeenCalled();
    },
  );

  it("answers 500 when the rules can't be read, so Shopify sends it again", async () => {
    // A refused token: never retried, unlike the network failures the rules
    // model's tests retry.
    h.graphql.mockRejectedValue(new Response(null, { status: 401 }));

    expect(
      (await deliver(collections, "collections/update", { id: 21 })).status,
    ).toBe(500);

    expect(h.db.job.create).not.toHaveBeenCalled();
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      level: "error",
      msg: "Collection check didn't finish",
      shop,
      collectionId: "gid://shopify/Collection/21",
    });
  });
});
