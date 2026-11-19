import { createHmac } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { action as customersDataRequest } from "./webhooks.customers.data_request";
import { action as customersRedact } from "./webhooks.customers.redact";
import { action as shopRedact } from "./webhooks.shop.redact";

// The three privacy webhooks (ARCHITECTURE §16) through the real
// authenticate.webhook, so every delivery's signature is checked with the app's
// secret. Only the database is mocked: a deleteMany for each table in
// prisma/schema.prisma, so a new table shows up here on its own.
const { db, secret } = vi.hoisted(() => {
  const secret = "test-api-secret";
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = secret;
  process.env.SHOPIFY_APP_URL = "https://fitted.test";
  return { db: {} as Record<string, Record<string, Mock>>, secret };
});
vi.mock("../db.server", async () => {
  const { Prisma } = await import("@prisma/client");
  for (const model of Object.values(Prisma.ModelName)) {
    db[model[0].toLowerCase() + model.slice(1)] = { deleteMany: vi.fn() };
  }
  // What the session storage reads: its startup check, then the offline
  // session, which is gone (app/uninstalled deleted it).
  Object.assign(db.session, { count: vi.fn(), findUnique: vi.fn() });
  return { default: db };
});

const shop = "fitted-test.myshopify.com";
const customer = {
  id: 191167,
  email: "shopper@example.com",
  phone: "555-625-1199",
};
// Shopify's sample payloads.
const payloads = {
  "customers/data_request": {
    shop_id: 954889,
    shop_domain: shop,
    orders_requested: [299938],
    customer,
    data_request: { id: 9999 },
  },
  "customers/redact": {
    shop_id: 954889,
    shop_domain: shop,
    customer,
    orders_to_redact: [299938],
  },
  "shop/redact": { shop_id: 954889, shop_domain: shop },
};
type Topic = keyof typeof payloads;
type Action = (args: ActionFunctionArgs) => Promise<Response>;

/** Answers as the route would: a Response the library throws is the reply. */
const deliver = (
  action: Action,
  topic: Topic,
  { signedWith = secret, signed = true } = {},
) => {
  const body = JSON.stringify(payloads[topic]);
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

const expectNoQueries = () => {
  for (const [table, queries] of Object.entries(db)) {
    for (const [name, query] of Object.entries(queries)) {
      expect(query, `${table}.${name}`).not.toHaveBeenCalled();
    }
  }
};

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const routes: [Topic, Action][] = [
  ["customers/data_request", customersDataRequest],
  ["customers/redact", customersRedact],
  ["shop/redact", shopRedact],
];

describe.each(routes)("%s webhook signature", (topic, action) => {
  it("refuses a delivery signed with another secret with 401, before any query", async () => {
    const response = await deliver(action, topic, {
      signedWith: "not-the-app-secret",
    });

    expect(response.status).toBe(401);
    expectNoQueries();
  });

  it("refuses an unsigned delivery with 400, before any query", async () => {
    const response = await deliver(action, topic, { signed: false });

    expect(response.status).toBe(400);
    expectNoQueries();
  });
});

describe.each(routes.slice(0, 2))("%s webhook", (topic, action) => {
  it("acknowledges a signed delivery and its repeat with 200, deleting nothing: Fitted stores no shopper data", async () => {
    expect((await deliver(action, topic)).status).toBe(200);
    expect((await deliver(action, topic)).status).toBe(200);

    for (const [table, { deleteMany }] of Object.entries(db)) {
      expect(deleteMany, table).not.toHaveBeenCalled();
    }
  });

  it("never logs the shopper the payload names", async () => {
    const output = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {}),
    );

    await deliver(action, topic);

    const logged = JSON.stringify(output.map((spy) => spy.mock.calls));
    expect(logged).toContain(shop);
    for (const value of Object.values(customer)) {
      expect(logged).not.toContain(String(value));
    }
  });
});

describe("shop/redact webhook", () => {
  it("deletes the shop's rows from every table in the app database and returns 200", async () => {
    const response = await deliver(shopRedact, "shop/redact");

    expect(response.status).toBe(200);
    expect(Object.keys(db)).toEqual(
      expect.arrayContaining(["session", "shop"]),
    );
    for (const [table, { deleteMany }] of Object.entries(db)) {
      expect(deleteMany, table).toHaveBeenCalledExactlyOnceWith({
        where: { shop },
      });
    }
  });

  it("returns 200 again when Shopify repeats the delivery and the rows are already gone", async () => {
    for (const { deleteMany } of Object.values(db)) {
      deleteMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
    }

    expect((await deliver(shopRedact, "shop/redact")).status).toBe(200);
    expect((await deliver(shopRedact, "shop/redact")).status).toBe(200);
    for (const [table, { deleteMany }] of Object.entries(db)) {
      expect(deleteMany, table).toHaveBeenCalledTimes(2);
    }
  });

  it("fails the request when a delete fails, so Shopify retries", async () => {
    db.shop.deleteMany.mockRejectedValue(new Error("database unavailable"));

    await expect(deliver(shopRedact, "shop/redact")).rejects.toThrow(
      "database unavailable",
    );
  });
});
