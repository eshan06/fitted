import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, upsert, unauthenticatedAdmin, adminGraphql, fetchMock } =
  vi.hoisted(() => ({
    findUnique: vi.fn(),
    upsert: vi.fn(),
    unauthenticatedAdmin: vi.fn(),
    adminGraphql: vi.fn(),
    fetchMock: vi.fn(),
  }));
vi.mock("../db.server", () => ({ default: { shop: { findUnique, upsert } } }));
vi.mock("../shopify.server", () => ({
  unauthenticated: { admin: unauthenticatedAdmin },
}));

let billing: typeof import("./billing.server");

const shop = "fitted-test.myshopify.com";
const otherShop = "other-test.myshopify.com";
const shopId = "gid://shopify/Shop/5678";
const appId = "gid://shopify/App/1234";
const token = "partner-token-for-tests";
const now = new Date("2026-11-18T12:00:00Z");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const subscription = (...handles: (string | null)[]) =>
  json({
    data: {
      activeSubscription: { items: handles.map((handle) => ({ handle })) },
    },
  });
const row = (plan: string, minutesOld: number, planOnStore = plan) => ({
  shop,
  plan,
  planCheckedAt: new Date(Date.now() - minutesOld * 60_000),
  planOnStore,
  resolvedAt: null,
});
const shopifyAdmin = async (query: string) =>
  query.includes("ShopId")
    ? json({ data: { shop: { id: shopId } } })
    : json({ data: { metafieldsSet: { userErrors: [] } } });
const storeWrites = () =>
  adminGraphql.mock.calls
    .filter(([query]) => String(query).includes("metafieldsSet"))
    .map(([, options]) => options.variables.metafields);
const confirmed = (plan: string) => ({ plan, checkFailed: false });
const failed = (plan: string) => ({ plan, checkFailed: true });

beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers({ now });
  // Like the real fetch, always a promise, whatever a test's mock returns.
  vi.stubGlobal("fetch", async (...args: unknown[]) => fetchMock(...args));
  vi.stubEnv("SHOPIFY_PARTNER_ORG_ID", "4321");
  vi.stubEnv("SHOPIFY_PARTNER_API_ACCESS_TOKEN", token);
  vi.stubEnv("SHOPIFY_APP_GID", appId);
  vi.spyOn(console, "log").mockImplementation(() => {});
  unauthenticatedAdmin.mockResolvedValue({ admin: { graphql: adminGraphql } });
  adminGraphql.mockImplementation(shopifyAdmin);
  // A fresh module per test: the throttle state lives in it.
  vi.resetModules();
  billing = await import("./billing.server");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("plan gates", () => {
  it("lets Free publish while under 3 Active charts, and paid plans any number", () => {
    expect(billing.canPublishChart("free", 2)).toBe(true);
    expect(billing.canPublishChart("free", 3)).toBe(false);
    expect(billing.canPublishChart("free", 7)).toBe(false); // after a downgrade
    expect(billing.canPublishChart("standard", 500)).toBe(true);
    expect(billing.canPublishChart("pro", 500)).toBe(true);
  });

  it("limits Free rules to the store default, products and collections", () => {
    for (const field of ["all", "product", "collection"]) {
      expect(billing.canUseRuleField("free", field)).toBe(true);
    }
    for (const field of ["tag", "type", "vendor", "metafield"]) {
      expect(billing.canUseRuleField("free", field)).toBe(false);
      expect(billing.canUseRuleField("standard", field)).toBe(true);
      expect(billing.canUseRuleField("pro", field)).toBe(true);
    }
  });

  it.each([
    ["free", false],
    ["standard", false],
    ["pro", true],
  ] as const)(
    "gives %s the fit finder, translation tools and fit finder stats: %s",
    (plan, pro) => {
      expect(billing.canShowFitFinder(plan)).toBe(pro);
      expect(billing.canUseTranslationTools(plan)).toBe(pro);
      expect(billing.canShowFitFinderStats(plan)).toBe(pro);
    },
  );
});

describe("getPlan", () => {
  it("serves a plan confirmed under 5 minutes ago from the cache", async () => {
    findUnique.mockResolvedValue(row("standard", 4.9));

    await expect(billing.getPlan(shop)).resolves.toEqual(confirmed("standard"));
    expect(findUnique).toHaveBeenCalledWith({ where: { shop } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unauthenticatedAdmin).not.toHaveBeenCalled();
  });

  it("re-checks an older plan with the Partner API and copies a change to the store", async () => {
    findUnique.mockResolvedValue(row("free", 6));
    fetchMock.mockResolvedValue(subscription("pro"));

    await expect(billing.getPlan(shop)).resolves.toEqual(confirmed("pro"));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://partners.shopify.com/4321/api/2026-07/graphql.json",
    );
    expect(init.headers["X-Shopify-Access-Token"]).toBe(token);
    expect(JSON.parse(init.body).variables).toEqual({ appId, shopId });
    expect(unauthenticatedAdmin).toHaveBeenCalledWith(shop);
    expect(storeWrites()).toEqual([
      [
        {
          ownerId: shopId,
          namespace: "$app",
          key: "plan",
          type: "single_line_text_field",
          value: "pro",
        },
      ],
    ]);
    const data = { plan: "pro", planCheckedAt: now, planOnStore: "pro" };
    expect(upsert).toHaveBeenCalledExactlyOnceWith({
      where: { shop },
      create: { shop, ...data },
      update: data,
    });
  });

  it("leaves the store alone when the plan hasn't changed", async () => {
    findUnique.mockResolvedValue(row("standard", 6));
    fetchMock.mockResolvedValue(subscription("standard"));

    await expect(billing.getPlan(shop)).resolves.toEqual(confirmed("standard"));
    expect(storeWrites()).toEqual([]);
    expect(upsert).toHaveBeenCalledOnce();
  });

  it.each([
    ["a first load", null],
    [
      "a reinstall",
      { ...row("pro", 0), planCheckedAt: null, planOnStore: null },
    ],
  ])("checks and writes the store on %s", async (_, cached) => {
    findUnique.mockResolvedValue(cached);
    fetchMock.mockResolvedValue(subscription("pro"));

    await expect(billing.getPlan(shop)).resolves.toEqual(confirmed("pro"));
    expect(storeWrites()).toMatchObject([[{ value: "pro" }]]);
  });

  it.each([
    [["standard"], "standard"],
    [["pro"], "pro"],
    [["free"], "free"],
    [["sms_meter", "standard"], "standard"],
  ])(
    "reads the plan from the subscription's handles %j",
    async (handles, plan) => {
      findUnique.mockResolvedValue(null);
      fetchMock.mockResolvedValue(subscription(...handles));

      await expect(billing.getPlan(shop)).resolves.toEqual(confirmed(plan));
    },
  );

  it.each([
    ["no subscription", () => json({ data: { activeSubscription: null } })],
    ["an unknown plan handle", () => subscription("enterprise")],
    ["an item without a handle", () => subscription(null)],
    ["a subscription with no items", () => subscription()],
  ])("treats %s as Free", async (_, respond) => {
    findUnique.mockResolvedValue(row("pro", 6));
    fetchMock.mockImplementation(respond);

    await expect(billing.getPlan(shop)).resolves.toEqual(confirmed("free"));
    expect(storeWrites()).toMatchObject([[{ value: "free" }]]);
  });

  // A null subscription alongside a failure must never read as "no subscription".
  const noSubscription = { activeSubscription: null };
  it.each([
    ["the Partner API fails", () => json({ data: noSubscription }, 500)],
    [
      "it returns errors",
      () =>
        json({ data: noSubscription, errors: [{ message: "Invalid token" }] }),
    ],
    [
      "its errors aren't a list",
      () => json({ data: noSubscription, errors: "Something broke" }),
    ],
    ["the response has no subscription field", () => json({ data: {} })],
    [
      "the subscription has no items list",
      () => json({ data: { activeSubscription: {} } }),
    ],
    ["the response isn't JSON", () => new Response("<html>")],
    ["the request fails", () => Promise.reject(new TypeError("fetch failed"))],
    [
      "the request fails quoting a header value",
      () =>
        Promise.reject(
          new TypeError(
            `Headers.append: "${token}" is an invalid header value.`,
          ),
        ),
    ],
  ])(
    "keeps the last confirmed plan and the store as they were when %s",
    async (_, respond) => {
      findUnique.mockResolvedValue(row("standard", 6));
      fetchMock.mockImplementation(respond);

      await expect(billing.getPlan(shop)).resolves.toEqual(failed("standard"));
      expect(storeWrites()).toEqual([]);
      expect(upsert).not.toHaveBeenCalled();
      const logged = vi.mocked(console.log).mock.calls.map(([line]) => line);
      expect(JSON.parse(logged[0])).toMatchObject({
        level: "error",
        shop,
        route: "billing",
      });
      expect(logged.join()).not.toContain(token);
    },
  );

  it("falls back to Free when no plan was ever confirmed", async () => {
    findUnique.mockResolvedValue(null);
    fetchMock.mockImplementation(() => json({}, 500));

    await expect(billing.getPlan(shop)).resolves.toEqual(failed("free"));
  });

  it("fails the check without calling the Partner API when it isn't configured", async () => {
    vi.stubEnv("SHOPIFY_PARTNER_API_ACCESS_TOKEN", "");
    findUnique.mockResolvedValue(null);

    await expect(billing.getPlan(shop)).resolves.toEqual(failed("free"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts a refused store write as a failed check, so the next check writes again", async () => {
    findUnique.mockResolvedValue(row("free", 6));
    fetchMock.mockImplementation(() => subscription("pro"));
    adminGraphql.mockImplementation(async (query: string) =>
      query.includes("ShopId")
        ? shopifyAdmin(query)
        : json({
            data: {
              metafieldsSet: {
                userErrors: [{ field: null, message: "Invalid" }],
              },
            },
          }),
    );

    await expect(billing.getPlan(shop)).resolves.toEqual(failed("free"));
    expect(upsert).not.toHaveBeenCalled();

    adminGraphql.mockImplementation(shopifyAdmin);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(billing.getPlan(shop)).resolves.toEqual(confirmed("pro"));
    expect(storeWrites()).toHaveLength(2);
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("starts no check within 10 seconds of the shop's last one", async () => {
    findUnique.mockResolvedValue(null);
    fetchMock.mockImplementation(() => json({}, 500));
    await billing.getPlan(shop);

    await vi.advanceTimersByTimeAsync(9_999);
    await expect(billing.getPlan(shop)).resolves.toEqual(failed("free"));
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    fetchMock.mockImplementation(() => subscription("pro"));
    await expect(billing.getPlan(shop)).resolves.toEqual(confirmed("pro"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails the check without calling the Partner API when the Admin API returns no shop id", async () => {
    findUnique.mockResolvedValue(row("standard", 6));
    adminGraphql.mockResolvedValue(json({ data: { shop: null } }));

    await expect(billing.getPlan(shop)).resolves.toEqual(failed("standard"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails the check when the store write returns no userErrors list", async () => {
    findUnique.mockResolvedValue(row("free", 6));
    fetchMock.mockResolvedValue(subscription("pro"));
    adminGraphql.mockImplementation(async (query: string) =>
      query.includes("ShopId")
        ? shopifyAdmin(query)
        : json({ data: { metafieldsSet: null } }),
    );

    await expect(billing.getPlan(shop)).resolves.toEqual(failed("free"));
    expect(upsert).not.toHaveBeenCalled();
  });

  it("repeats the store write when the cache write failed after it", async () => {
    findUnique.mockResolvedValue(row("free", 6));
    fetchMock.mockImplementation(() => subscription("pro"));
    upsert.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(billing.getPlan(shop)).resolves.toEqual(failed("free"));
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(billing.getPlan(shop)).resolves.toEqual(confirmed("pro"));
    expect(storeWrites()).toMatchObject([
      [{ value: "pro" }],
      [{ value: "pro" }],
    ]);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("gives each call to Shopify 5 seconds, so a hung call can't hold every load", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    findUnique.mockResolvedValue(null);
    fetchMock.mockResolvedValue(subscription("pro"));

    await billing.getPlan(shop);

    expect(timeout.mock.calls).toEqual([[5_000], [5_000], [5_000]]);
    const [shopIdCall, writeCall] = adminGraphql.mock.calls;
    const signals = timeout.mock.results.map(({ value }) => value);
    expect(signals).toContain(shopIdCall[1].signal);
    expect(signals).toContain(fetchMock.mock.calls[0][1].signal);
    expect(signals).toContain(writeCall[1].signal);
  });

  it("shares one check between two loads at once", async () => {
    findUnique.mockResolvedValue(null);
    fetchMock.mockResolvedValue(subscription("pro"));

    const results = await Promise.all([
      billing.getPlan(shop),
      billing.getPlan(shop),
    ]);
    expect(results).toEqual([confirmed("pro"), confirmed("pro")]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("joins a check that's still running past the 10-second gap", async () => {
    findUnique.mockResolvedValue(row("free", 6));
    fetchMock.mockResolvedValue(subscription("pro"));
    let finishWrite = () => {};
    adminGraphql.mockImplementation((query: string) =>
      query.includes("ShopId")
        ? shopifyAdmin(query)
        : new Promise<Response>((resolve) => {
            finishWrite = () => resolve(shopifyAdmin(query));
          }),
    );
    const slow = billing.getPlan(shop);

    await vi.advanceTimersByTimeAsync(12_000);
    const load = billing.getPlan(shop);
    finishWrite();

    await expect(Promise.all([slow, load])).resolves.toEqual([
      confirmed("pro"),
      confirmed("pro"),
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("doubts a fresh cached plan after a re-check fails, until a check succeeds", async () => {
    findUnique.mockResolvedValue(row("free", 1));
    fetchMock
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(subscription("pro"));
    await expect(billing.getPlan(shop, { recheck: true })).resolves.toEqual(
      failed("free"),
    );

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(billing.getPlan(shop)).resolves.toEqual(failed("free"));
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(7_000);
    await expect(billing.getPlan(shop)).resolves.toEqual(confirmed("pro"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe("welcome link re-check", () => {
    it("re-checks at once even when the cached plan is fresh", async () => {
      findUnique.mockResolvedValue(row("free", 1));
      fetchMock.mockResolvedValue(subscription("pro"));

      await expect(billing.getPlan(shop, { recheck: true })).resolves.toEqual(
        confirmed("pro"),
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("is delayed, not dropped, inside the 10 seconds after the last check", async () => {
      findUnique.mockResolvedValue(row("standard", 6));
      fetchMock
        .mockResolvedValueOnce(subscription("standard"))
        .mockResolvedValueOnce(subscription("pro"));
      await billing.getPlan(shop);

      await vi.advanceTimersByTimeAsync(3_000);
      const recheck = billing.getPlan(shop, { recheck: true });
      await vi.advanceTimersByTimeAsync(6_999);
      expect(fetchMock).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1);
      await expect(recheck).resolves.toEqual(confirmed("pro"));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("holds other loads until it lands instead of serving the cached plan", async () => {
      findUnique.mockResolvedValue(row("standard", 1));
      fetchMock
        .mockResolvedValueOnce(subscription("standard"))
        .mockResolvedValueOnce(subscription("pro"));
      await billing.getPlan(shop, { recheck: true });

      await vi.advanceTimersByTimeAsync(3_000);
      const recheck = billing.getPlan(shop, { recheck: true });
      const load = billing.getPlan(shop);
      await vi.advanceTimersByTimeAsync(7_000);

      await expect(Promise.all([recheck, load])).resolves.toEqual([
        confirmed("pro"),
        confirmed("pro"),
      ]);
    });

    it("shares one waiting check between two re-checks", async () => {
      findUnique.mockResolvedValue(null);
      fetchMock.mockImplementation(() => subscription("pro"));
      await billing.getPlan(shop);

      await vi.advanceTimersByTimeAsync(1_000);
      const first = billing.getPlan(shop, { recheck: true });
      await vi.advanceTimersByTimeAsync(1_000);
      const second = billing.getPlan(shop, { recheck: true });
      await vi.advanceTimersByTimeAsync(20_000);

      await expect(Promise.all([first, second])).resolves.toEqual([
        confirmed("pro"),
        confirmed("pro"),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("doesn't settle for a check that started before it", async () => {
      findUnique.mockResolvedValue(null);
      let respond: (response: Response) => void = () => {};
      fetchMock
        .mockReturnValueOnce(new Promise((resolve) => (respond = resolve)))
        .mockResolvedValueOnce(subscription("pro"));
      const running = billing.getPlan(shop);
      await vi.advanceTimersByTimeAsync(0);

      const recheck = billing.getPlan(shop, { recheck: true });
      respond(subscription("standard"));
      await expect(running).resolves.toEqual(confirmed("standard"));
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(recheck).resolves.toEqual(confirmed("pro"));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("waits for a slow check to finish, so an older read can't land last", async () => {
      findUnique.mockResolvedValue(row("free", 6));
      fetchMock
        .mockResolvedValueOnce(subscription("standard"))
        .mockResolvedValueOnce(subscription("pro"));
      let finishWrite = () => {};
      // The first store write hangs past the 10 second gap.
      adminGraphql.mockImplementation((query: string) =>
        query.includes("ShopId") || storeWrites().length > 1
          ? shopifyAdmin(query)
          : new Promise<Response>((resolve) => {
              finishWrite = () => resolve(shopifyAdmin(query));
            }),
      );
      const slow = billing.getPlan(shop);
      await vi.advanceTimersByTimeAsync(1_000);
      const recheck = billing.getPlan(shop, { recheck: true });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(fetchMock).toHaveBeenCalledOnce();

      finishWrite();
      await expect(slow).resolves.toEqual(confirmed("standard"));
      await expect(recheck).resolves.toEqual(confirmed("pro"));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    [
      "an HTTP 429",
      () => json({ errors: [{ message: "Too many requests" }] }, 429),
    ],
    [
      "a throttled error in a 200",
      () =>
        json({
          errors: [{ message: "Throttled", extensions: { code: "429" } }],
        }),
    ],
  ])(
    "holds every shop's checks for 2 seconds after %s",
    async (_, throttled) => {
      findUnique.mockResolvedValue(null);
      fetchMock
        .mockImplementationOnce(throttled)
        .mockImplementationOnce(() => subscription("pro"));
      await expect(billing.getPlan(shop)).resolves.toEqual(failed("free"));

      const other = billing.getPlan(otherShop);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1);
      await expect(other).resolves.toEqual(confirmed("pro"));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("holds a check that started before a 429, and again when another 429 lands while it waits", async () => {
    const tooMany = () =>
      json({ errors: [{ message: "Too many requests" }] }, 429);
    const respond: ((response: Response) => void)[] = [];
    const pending = () =>
      new Promise<Response>((resolve) => respond.push(resolve));
    findUnique.mockResolvedValue(null);
    fetchMock
      .mockImplementationOnce(pending)
      .mockImplementationOnce(pending)
      .mockResolvedValueOnce(subscription("pro"));
    // This shop's check is still reading its shop id when the 429s land.
    let releaseShopId = () => {};
    unauthenticatedAdmin.mockImplementation(async (forShop: string) => ({
      admin: {
        graphql:
          forShop === shop
            ? (query: string) =>
                query.includes("ShopId")
                  ? new Promise<Response>((resolve) => {
                      releaseShopId = () => resolve(shopifyAdmin(query));
                    })
                  : shopifyAdmin(query)
            : adminGraphql,
      },
    }));
    const held = billing.getPlan(shop);
    void billing.getPlan("b-test.myshopify.com");
    void billing.getPlan("c-test.myshopify.com");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    respond[0](tooMany()); // every check now waits until 2s
    await vi.advanceTimersByTimeAsync(0);
    releaseShopId();
    await vi.advanceTimersByTimeAsync(1_000);
    respond[1](tooMany()); // and now until 3s
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(500);
    await expect(held).resolves.toEqual(confirmed("pro"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("holds a re-check waiting for the gap when a 429 lands meanwhile", async () => {
    findUnique.mockResolvedValue(null);
    fetchMock
      .mockResolvedValueOnce(subscription("standard"))
      .mockResolvedValueOnce(
        json({ errors: [{ message: "Too many requests" }] }, 429),
      )
      .mockResolvedValueOnce(subscription("pro"));
    await billing.getPlan(shop);
    const recheck = billing.getPlan(shop, { recheck: true }); // waits until 10s

    await vi.advanceTimersByTimeAsync(9_000);
    await billing.getPlan(otherShop); // throttled: every check waits until 11s
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(500);
    await expect(recheck).resolves.toEqual(confirmed("pro"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
