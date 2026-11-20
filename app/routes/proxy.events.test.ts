import { createHmac, randomUUID } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "./proxy.events";

// The size guide's events (ARCHITECTURE §12) through the real
// authenticate.public.appProxy, so every request's signature is checked with
// the app's secret, the way Shopify signs a request it proxies. Only the
// database is faked; db.server.test.ts runs the write on Postgres.
const h = vi.hoisted(() => {
  const secret = "test-api-secret";
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = secret;
  process.env.SHOPIFY_APP_URL = "https://fitted.test";
  const db = {
    // What the session storage reads: its startup check, then the offline
    // session, which the endpoint doesn't need.
    session: { count: vi.fn(), findUnique: vi.fn() },
    event: { createMany: vi.fn() },
  };
  return { secret, db };
});
vi.mock("../db.server", () => ({ default: h.db }));

const CHART = "gid://shopify/Metaobject/1301";
const PRODUCT = "gid://shopify/Product/8812";
const SHOPIFY_IP = "23.227.38.32"; // the proxy's, which the host adds last
const CUSTOMER = "7700991";
// Each test's own shop, so the counts in the endpoint's memory start at zero.
let shop: string;
const open = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  type: "open",
  chart: CHART,
  product: PRODUCT,
  ...over,
});

type Options = {
  forShop?: string;
  ip?: string;
  xff?: string;
  secret?: string | null; // null sends no signature
  ageSeconds?: number;
  tamper?: (query: URLSearchParams) => void; // a change made after signing
  headers?: Record<string, string>;
};
/** A POST as Shopify forwards it from the storefront, signed with the app's secret. */
const post = (
  body: unknown,
  {
    forShop = shop,
    ip = "203.0.113.7",
    xff = `${ip}, ${SHOPIFY_IP}`,
    secret = h.secret,
    ageSeconds = 0,
    tamper,
    headers = {},
  }: Options = {},
) => {
  const query = new URLSearchParams({
    shop: forShop,
    logged_in_customer_id: CUSTOMER,
    path_prefix: "/apps/fitted",
    timestamp: `${Math.floor(Date.now() / 1000) - ageSeconds}`,
  });
  // Shopify's message: the parameters sorted, each key=value, joined with nothing.
  const message = [...query]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  if (secret !== null)
    query.set(
      "signature",
      createHmac("sha256", secret).update(message).digest("hex"),
    );
  tamper?.(query);
  return new Request(`https://fitted.test/proxy/events?${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "User-Agent": "Mozilla/5.0 (TestPhone) TestBrowser/1.0",
      "X-Forwarded-For": xff,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
};

/** Answers as React Router would: a Response the library throws is the reply. */
const send = (request: Request) =>
  action({ request } as ActionFunctionArgs).catch((thrown: unknown) => {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  });
const status = async (body: unknown, options?: Options) =>
  (await send(post(body, options))).status;
const written = () =>
  h.db.event.createMany.mock.calls.map(([q]) => q.data as object);

beforeEach(() => {
  vi.resetAllMocks();
  h.db.event.createMany.mockResolvedValue({ count: 1 });
  shop = `events-${randomUUID()}.myshopify.com`;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a size guide event", () => {
  it("is stored for the shop Shopify signed for, with nothing about the shopper, and answers 204", async () => {
    const event = open();

    const response = await send(
      post(event, {
        headers: {
          // Headers anyone can set name no shop the endpoint uses.
          "X-Forwarded-Host": "someone-else.example",
          "X-Shopify-Shop-Domain": "someone-else.myshopify.com",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(h.db.event.createMany).toHaveBeenCalledExactlyOnceWith({
      data: {
        shop,
        id: event.id,
        type: "open",
        chartId: CHART,
        productId: PRODUCT,
        size: null,
      },
      skipDuplicates: true,
    });
    const stored = JSON.stringify(h.db.event.createMany.mock.calls);
    for (const shopper of [CUSTOMER, "203.0.113.7", "TestBrowser"])
      expect(stored).not.toContain(shopper);
  });

  it("keeps a fit result's recommended size, a fit result with none, and an add to cart's size", async () => {
    const events = [
      open({ type: "fit_result", size: "m" }),
      open({ type: "fit_result" }),
      open({ type: "add_to_cart", size: "xl2" }),
    ];

    for (const event of events) expect(await status(event)).toBe(204);

    expect(written()).toEqual([
      expect.objectContaining({ type: "fit_result", size: "m" }),
      expect.objectContaining({ type: "fit_result", size: null }),
      expect.objectContaining({ type: "add_to_cart", size: "xl2" }),
    ]);
  });

  it("answers a replay with 204, through a write that skips the id it already has", async () => {
    const event = open();
    h.db.event.createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    expect(await status(event)).toBe(204);
    expect(await status(event)).toBe(204);

    expect(h.db.event.createMany.mock.calls.map(([q]) => q)).toEqual([
      { data: expect.objectContaining({ id: event.id }), skipDuplicates: true },
      { data: expect.objectContaining({ id: event.id }), skipDuplicates: true },
    ]);
  });

  it("answers 500 and logs the shop, never the shopper, when the write fails", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    h.db.event.createMany.mockRejectedValue(new Error("database unavailable"));

    expect(await status(open())).toBe(500);

    // The library's own lines aren't JSON; they name only the shop too.
    const lines = logs.mock.calls.map(([line]) => String(line));
    expect(
      lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)),
    ).toEqual([
      {
        level: "error",
        msg: "Event not saved",
        shop,
        route: "proxy/events",
        error: "Error: database unavailable",
      },
    ]);
    for (const shopper of [CUSTOMER, "203.0.113.7", "TestBrowser"])
      expect(lines.join("\n")).not.toContain(shopper);
  });
});

describe("the proxy signature", () => {
  const other = "someone-else.myshopify.com";
  it.each<[string, Options]>([
    ["signed with another secret", { secret: "not-the-app-secret" }],
    ["unsigned", { secret: null }],
    [
      "whose shop changed after signing",
      { tamper: (q) => q.set("shop", other) },
    ],
    ["with a second shop added", { tamper: (q) => q.append("shop", other) }],
    ["over 90 seconds old", { ageSeconds: 91 }],
    ["over 90 seconds ahead", { ageSeconds: -91 }],
  ])(
    "refuses a request %s with 400, before anything is read or stored",
    async (_, options) => {
      expect(await status(open(), options)).toBe(400);

      expect(h.db.session.findUnique).not.toHaveBeenCalled();
      expect(h.db.event.createMany).not.toHaveBeenCalled();
    },
  );

  it("accepts a timestamp within 90 seconds", async () => {
    expect(await status(open(), { ageSeconds: 85 })).toBe(204);
  });
});

describe("a body that isn't one event", () => {
  const id = randomUUID();
  it.each<[string, unknown]>([
    ["empty", ""],
    ["not JSON", "type=open"],
    ["a list", [open()]],
    ["null", null],
    ["without an id", { ...open(), id: undefined }],
    ["with an id that isn't a v4 UUID", open({ id: id.toUpperCase() })],
    ["with a v1 UUID", open({ id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" })],
    ["of an unknown type", open({ type: "view" })],
    ["of a type off Object's prototype", open({ type: "constructor" })],
    ["with the shop in it", open({ shop: "someone-else.myshopify.com" })],
    ["with a customer in it", open({ customer: CUSTOMER })],
    ["with a product id as the chart", open({ chart: PRODUCT })],
    ["with a chart id as the product", open({ product: CHART })],
    ["with a GID padded with text", open({ chart: `${CHART}x` })],
    ["with a numeric product id", open({ product: 8812 })],
    ["with a size on an open", open({ size: "m" })],
    ["adding to cart without a size", open({ type: "add_to_cart" })],
    [
      "with a size that isn't a size row id",
      open({ type: "fit_result", size: "M" }),
    ],
    [
      "with a size over 8 characters",
      open({ type: "fit_result", size: "abcdefghi" }),
    ],
    ["with a null size", open({ type: "fit_result", size: null })],
    [
      "over 1 KB, though valid without its padding",
      `${JSON.stringify(open())}${" ".repeat(1024)}`,
    ],
  ])(
    "is refused with 400 when it's %s, and nothing is stored",
    async (_, body) => {
      expect(await status(body)).toBe(400);
      expect(h.db.event.createMany).not.toHaveBeenCalled();
    },
  );

  it("can be 1 KB exactly", async () => {
    const json = JSON.stringify(open());
    expect(await status(json + " ".repeat(1024 - json.length))).toBe(204);
  });

  it("stops reading a stream that runs past 1 KB", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(512).fill(32));
      },
    });
    const request = post("");
    const streamed = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: endless,
      duplex: "half",
    } as RequestInit);

    expect((await send(streamed)).status).toBe(400);
    expect(pulled).toBeLessThan(6);
    expect(h.db.event.createMany).not.toHaveBeenCalled();
  });
});

describe("the rate limits", () => {
  it("refuse a 31st request in a minute from one IP for one shop with 429, counting bad ones too, until the minute is up", async () => {
    vi.useFakeTimers({
      now: new Date("2026-11-20T10:00:00Z"),
      toFake: ["Date"],
    });
    for (let i = 0; i < 10; i++) expect(await status("not an event")).toBe(400);
    for (let i = 0; i < 20; i++) expect(await status(open())).toBe(204);

    expect(await status(open())).toBe(429);
    expect(h.db.event.createMany).toHaveBeenCalledTimes(20);
    // Another shopper, and the same shopper on another store, go on.
    expect(await status(open(), { ip: "198.51.100.4" })).toBe(204);
    expect(
      await status(open(), { forShop: `other-${randomUUID()}.myshopify.com` }),
    ).toBe(204);

    vi.setSystemTime(new Date("2026-11-20T10:01:00Z"));
    expect(await status(open())).toBe(204);
  });

  it("count the entry Shopify adds, never ones the browser sends before it", async () => {
    for (let i = 0; i < 30; i++)
      expect(
        await status(open(), {
          xff: `10.0.0.${i}, 203.0.113.7, ${SHOPIFY_IP}`,
        }),
      ).toBe(204);

    expect(
      await status(open(), { xff: `10.9.9.9, 203.0.113.7, ${SHOPIFY_IP}` }),
    ).toBe(429);
  });

  it("leave a request without the shopper's IP to the day's cap alone", async () => {
    for (let i = 0; i < 40; i++)
      expect(await status(open(), { xff: SHOPIFY_IP })).toBe(204);
  });

  it("store 20,000 events a UTC day per shop, then refuse with 429 until the next day", async () => {
    vi.useFakeTimers({
      now: new Date("2026-11-20T23:00:00Z"),
      toFake: ["Date"],
    });
    // A replay stores nothing, so it doesn't count.
    h.db.event.createMany.mockResolvedValueOnce({ count: 0 });
    for (let i = 0; i <= 20_000; i++) {
      const ip = `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`;
      if ((await status(open(), { ip })) !== 204) throw new Error(`#${i}`);
    }

    expect(await status(open(), { ip: "198.51.100.4" })).toBe(429);
    expect(h.db.event.createMany).toHaveBeenCalledTimes(20_001);
    expect(
      await status(open(), { forShop: `other-${randomUUID()}.myshopify.com` }),
    ).toBe(204);

    vi.setSystemTime(new Date("2026-11-21T00:00:00Z"));
    expect(await status(open(), { ip: "198.51.100.4" })).toBe(204);
  }, 30_000);
});
