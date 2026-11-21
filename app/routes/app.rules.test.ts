import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError, AdminApiError } from "../models/admin.server";
import {
  RulesConflictError,
  RulesPlanError,
  StoredRulesError,
  type Rules,
} from "../models/rules.server";

const m = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getPlan: vi.fn(),
  chartPages: vi.fn(),
  getRules: vi.fn(),
  saveRules: vi.fn(),
  startResolve: vi.fn(),
  canReadProducts: vi.fn(),
  pricingPlansUrl: vi.fn(),
  latestResolve: vi.fn(),
  countProducts: vi.fn(),
  countChartProducts: vi.fn(),
  pickedNames: vi.fn(),
  chartPreview: vi.fn(),
}));
vi.mock("../shopify.server", () => ({
  authenticate: { admin: m.authenticate },
}));
vi.mock("../db.server", () => ({ default: {} }));
vi.mock("../models/admin.server", async (orig) => ({
  ...(await orig<typeof import("../models/admin.server")>()),
  canReadProducts: m.canReadProducts,
  pricingPlansUrl: m.pricingPlansUrl,
}));
vi.mock("../models/billing.server", async (orig) => ({
  ...(await orig<typeof import("../models/billing.server")>()),
  getPlan: m.getPlan,
}));
vi.mock("../models/chart.server", async (orig) => ({
  ...(await orig<typeof import("../models/chart.server")>()),
  chartPages: m.chartPages,
  countChartProducts: m.countChartProducts,
}));
// The real validator and errors; only the Shopify calls are stubbed.
vi.mock("../models/rules.server", async (orig) => ({
  ...(await orig<typeof import("../models/rules.server")>()),
  getRules: m.getRules,
  saveRules: m.saveRules,
  startResolve: m.startResolve,
  latestResolve: m.latestResolve,
  countProducts: m.countProducts,
  pickedNames: m.pickedNames,
  chartPreview: m.chartPreview,
}));
const { action, loader } = await import("./app.rules");
const { COPY } = await import("../components/rules/RulesEditor");
// §15: every refusal carries a code and the words the screen shows.
const answer = (code: string) => ({
  error: { code, message: COPY[code][1] },
});

const SHOP = "fitted-dev.myshopify.com";
const JOB = { status: "done", error: null, at: 1000, merchant: true };
const PLANS =
  "https://admin.shopify.com/store/fitted-dev/charges/fitted-5/pricing_plans";
const CHART = "gid://shopify/Metaobject/42";
const COUNTS = { [CHART]: { count: 148, atLeast: false } };
const NAMES = { "gid://shopify/Product/1": "Linen wrap top" };
const admin = { graphql: vi.fn() };
const rules = (): Rules => ({
  v: 1,
  order: [CHART],
  charts: {
    [CHART]: {
      match: [{ field: "product", op: "is", ids: ["gid://shopify/Product/1"] }],
      exclude: [],
      auto: true,
    },
  },
});
async function* pages(...lists: { id: string; name: string }[][]) {
  for (const l of lists) yield l;
}

const load = (search = "") =>
  loader({
    request: new Request(`https://fitted.test/app/rules${search}`),
  } as unknown as LoaderFunctionArgs);
const post = (body: unknown) =>
  action({
    request: new Request("https://fitted.test/app/rules", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  } as unknown as ActionFunctionArgs);
// data() results carry their status in `init`; plain objects are a 200.
const result = async (p: Promise<unknown>) => {
  const r = (await p) as { type?: string; data?: unknown; init?: ResponseInit };
  return r?.type === "DataWithResponseInit"
    ? { status: r.init?.status, body: r.data }
    : { status: 200, body: r };
};

let logs: string[];
beforeEach(() => {
  vi.resetAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => logs.push(line));
  m.authenticate.mockResolvedValue({ admin, session: { shop: SHOP } });
  m.getPlan.mockResolvedValue({ plan: "standard", checkFailed: false });
  m.chartPages.mockImplementation(() =>
    pages([{ id: CHART, name: "Women's tops" } as never]),
  );
  m.getRules.mockResolvedValue({ rules: rules(), digest: "d1", shopId: "s" });
  m.saveRules.mockResolvedValue("d2");
  m.canReadProducts.mockResolvedValue(true);
  m.startResolve.mockResolvedValue(undefined);
  m.latestResolve.mockResolvedValue(JOB);
  m.countProducts.mockResolvedValue(340);
  m.pricingPlansUrl.mockResolvedValue(PLANS);
  m.countChartProducts.mockResolvedValue(COUNTS);
  m.pickedNames.mockResolvedValue(NAMES);
});
afterEach(() => vi.restoreAllMocks());

describe("loading display rules", () => {
  it("loads every chart's name with the rules and their digest", async () => {
    m.chartPages.mockImplementation(() =>
      pages(
        [{ id: CHART, name: "Women's tops", status: "ACTIVE" } as never],
        [{ id: "gid://shopify/Metaobject/7", name: "Shoes" } as never],
      ),
    );
    expect(await load()).toEqual({
      mode: "edit",
      charts: [
        { id: CHART, name: "Women's tops" },
        { id: "gid://shopify/Metaobject/7", name: "Shoes" },
      ],
      rules: rules(),
      digest: "d1",
      damaged: null,
      job: JOB,
      unread: false,
      products: 340,
      counts: COUNTS,
      names: NAMES,
      free: false,
      plansUrl: null,
    });
    expect(m.countChartProducts).toHaveBeenCalledWith(admin, [
      CHART,
      "gid://shopify/Metaobject/7",
    ]);
    expect(m.pickedNames).toHaveBeenCalledWith(admin, rules());
    expect(m.authenticate).toHaveBeenCalledOnce();
    expect(m.latestResolve).toHaveBeenCalledWith(SHOP);
    expect(m.pricingPlansUrl).not.toHaveBeenCalled();
  });

  it("answers the screen's poll with the newest resolve alone", async () => {
    expect(await load("?job")).toEqual({ mode: "job", job: JOB });
    expect(m.latestResolve).toHaveBeenCalledWith(SHOP);
    expect(m.chartPages).not.toHaveBeenCalled();
  });

  // Regression (#115): a failed read of the resolve job showed an error page.
  it("keeps the screen when the resolve job can't be read: the load without progress, the poll says so", async () => {
    m.latestResolve.mockRejectedValue(new Error("Can't reach database"));
    expect(await load()).toMatchObject({
      mode: "edit",
      job: null,
      unread: true,
    });
    expect(await result(load("?job"))).toEqual({
      status: 503,
      body: { mode: "job", job: null, failed: true },
    });
    expect(JSON.parse(logs[0])).toEqual({
      level: "error",
      msg: "Couldn't read the resolve job",
      shop: SHOP,
      route: "app.rules",
      detail: "Error: Can't reach database",
    });
  });

  it("links Free to the plans page by the app's real handle, and loads without a count or link Shopify won't give", async () => {
    m.getPlan.mockResolvedValue({ plan: "free", checkFailed: false });
    expect(await load()).toMatchObject({ free: true, plansUrl: PLANS });
    expect(m.pricingPlansUrl).toHaveBeenCalledWith(admin, SHOP);
    // Staff without Products access can't count them.
    m.countProducts.mockRejectedValue(new AdminApiError("Denied", "raw"));
    m.pricingPlansUrl.mockRejectedValue(new AdminApiError("Down", "raw"));
    // Without counts the list shows none; without names picks show a count.
    m.countChartProducts.mockRejectedValue(new AdminApiError("Down", "raw"));
    m.pickedNames.mockRejectedValue(new AdminApiError("Down", "raw"));
    expect(await load()).toMatchObject({
      mode: "edit",
      products: null,
      plansUrl: null,
      counts: null,
      names: {},
    });
    expect(logs).toHaveLength(4);
  });

  it("answers the matches card with the chart's products, from the session's shop", async () => {
    const preview = { count: 148, atLeast: false, products: [], url: "u" };
    m.chartPreview.mockResolvedValue(preview);
    const q = `?preview=${encodeURIComponent(CHART)}`;
    expect(await load(q)).toEqual({ mode: "preview", preview });
    expect(m.chartPreview).toHaveBeenCalledWith(admin, SHOP, CHART);
    expect(m.chartPages).not.toHaveBeenCalled();
  });

  it("refuses a preview of anything but a chart, before asking Shopify", async () => {
    // The real check: the id goes into Shopify's search text.
    const real = await vi.importActual<typeof import("../models/rules.server")>(
      "../models/rules.server",
    );
    m.chartPreview.mockImplementation(real.chartPreview);
    for (const id of ['1" OR title:*', "gid://shopify/Product/1", ""])
      expect(await result(load(`?preview=${encodeURIComponent(id)}`))).toEqual({
        status: 400,
        body: { mode: "preview", preview: null },
      });
    expect(admin.graphql).not.toHaveBeenCalled();
  });

  it("leaves the matches card out, and logs, when Shopify gives no preview", async () => {
    m.chartPreview.mockRejectedValue(new AdminApiError("Denied", "raw"));
    expect(await load(`?preview=${encodeURIComponent(CHART)}`)).toEqual({
      mode: "preview",
      preview: null,
    });
    expect(logs).toHaveLength(1);
  });

  it("says rules need a chart when the store has none", async () => {
    m.chartPages.mockImplementation(() => pages([]));
    expect(await load()).toEqual({ mode: "empty" });
    expect(m.getRules).not.toHaveBeenCalled();
  });

  it("starts blank with the stored digest when the saved rules fail the checks, naming each problem", async () => {
    const stored = {
      v: 1,
      order: [CHART],
      charts: {
        [CHART]: {
          match: [
            { field: "tag", op: "is", value: "" },
            { field: "metafield", key: "custom fit", op: "is", value: "x" },
          ],
        },
      },
    };
    m.getRules.mockRejectedValue(
      new StoredRulesError(
        {
          [`charts.${CHART}.match.0.value`]: "Use 1 to 255 characters",
          [`charts.${CHART}.match.1.key`]: "Use namespace.key",
          [`charts.${CHART}.auto`]: "Must be true or false",
          "charts.gid://shopify/Metaobject/9": "Not in the priority list",
        },
        "d0",
        stored,
      ),
    );
    expect(await load()).toMatchObject({
      mode: "edit",
      rules: { v: 1, order: [], charts: {} },
      digest: "d0",
      damaged: [
        "Women's tops: a tag condition has no value",
        "Women's tops: custom fit isn't a metafield key",
        "Women's tops: must be true or false",
        "Not in the priority list",
      ],
      names: {},
    });
  });

  it("answers 502 and logs Shopify's text when the store can't be read", async () => {
    m.getRules.mockRejectedValue(
      new AdminApiError("Shopify request failed", "HTTP 503"),
    );
    expect(await result(load())).toEqual({
      status: 502,
      body: {
        mode: "error",
        error: {
          code: "shopify",
          message:
            "Fitted couldn't reach your store just now. Your charts still show on the same products as before.",
        },
      },
    });
    expect(JSON.parse(logs[0])).toMatchObject({
      level: "error",
      shop: SHOP,
      route: "app.rules",
      detail: "HTTP 503",
    });
  });

  it("answers 403 saying so when Shopify refuses the staff member the charts or rules (§15)", async () => {
    const denied = () =>
      new AccessDeniedError("Access denied for metaobjects field.");
    m.chartPages.mockImplementationOnce(async function* () {
      yield [];
      throw denied();
    });
    m.getRules.mockRejectedValueOnce(denied());
    for (let i = 0; i < 2; i++)
      expect(await result(load())).toEqual({
        status: 403,
        body: {
          mode: "error",
          error: {
            code: "access",
            message: expect.stringContaining("You need Products access"),
          },
        },
      });
    expect(JSON.parse(logs[0])).toMatchObject({
      shop: SHOP,
      route: "app.rules",
      detail: "Access denied for metaobjects field.",
    });
  });

  it("still loads without the counts and names Shopify refuses staff without Products access", async () => {
    const denied = new AccessDeniedError("Access denied for products field.");
    m.countProducts.mockRejectedValue(denied);
    m.countChartProducts.mockRejectedValue(denied);
    m.pickedNames.mockRejectedValue(denied);
    expect(await load()).toMatchObject({
      mode: "edit",
      products: null,
      counts: null,
      names: {},
    });
  });

  it("passes the library's login redirect on without reading the store", async () => {
    const login = new Response(null, { status: 302 });
    m.authenticate.mockRejectedValue(login);
    await expect(load()).rejects.toBe(login);
    expect(m.chartPages).not.toHaveBeenCalled();
  });
});

describe("saving display rules", () => {
  it("saves over the loaded digest on the shop's plan, then applies them to every product", async () => {
    expect(await result(post({ rules: rules(), digest: "d1" }))).toEqual({
      status: 200,
      body: { ok: true, after: 1000 },
    });
    expect(m.getPlan).toHaveBeenCalledWith(SHOP);
    expect(m.saveRules).toHaveBeenCalledWith(admin, rules(), "d1", "standard");
    expect(m.startResolve).toHaveBeenCalledExactlyOnceWith(SHOP, true);
  });

  it("answers a resent save like the first: the model returns the stored digest (§15)", async () => {
    await post({ rules: rules(), digest: "d1" });
    m.latestResolve.mockResolvedValue(null);
    expect(await result(post({ rules: rules(), digest: "d1" }))).toEqual({
      status: 200,
      body: { ok: true, after: 0 },
    });
    expect(m.saveRules).toHaveBeenCalledTimes(2);
  });

  it("applies the saved rules again on Try again, without saving", async () => {
    expect(await result(post({ intent: "apply", rules: {} }))).toEqual({
      status: 200,
      body: { ok: true, after: 1000 },
    });
    expect(m.saveRules).not.toHaveBeenCalled();
    expect(m.startResolve).toHaveBeenCalledExactlyOnceWith(SHOP, true);
    // Staff without Products access can't start one either.
    m.canReadProducts.mockResolvedValue(false);
    expect(await result(post({ intent: "apply" }))).toEqual({
      status: 403,
      body: answer("product_access"),
    });
    expect(m.startResolve).toHaveBeenCalledOnce();
  });

  // Regression (#115): a failed read after the save showed an error page and skipped the resolve.
  it("still applies the saved rules when the resolve job can't be read", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5000);
    m.latestResolve.mockRejectedValue(new Error("Can't reach database"));
    expect(await result(post({ rules: rules(), digest: "d1" }))).toEqual({
      status: 200,
      body: { ok: true, after: 4999 },
    });
    expect(m.saveRules).toHaveBeenCalledOnce();
    expect(m.startResolve).toHaveBeenCalledExactlyOnceWith(SHOP, true);
    expect(JSON.parse(logs[0])).toMatchObject({
      msg: "Couldn't read the resolve job",
    });
  });

  it("refuses staff without Products access before saving anything", async () => {
    m.canReadProducts.mockResolvedValue(false);
    expect(await result(post({ rules: rules(), digest: "d1" }))).toEqual({
      status: 403,
      body: answer("product_access"),
    });
    expect(m.saveRules).not.toHaveBeenCalled();
    expect(m.startResolve).not.toHaveBeenCalled();
  });

  it("says so when Shopify refuses the staff member the save itself (403, §15)", async () => {
    m.saveRules.mockRejectedValue(
      new AccessDeniedError("Access denied for metafieldsSet field."),
    );
    expect(await result(post({ rules: rules(), digest: "d1" }))).toEqual({
      status: 403,
      body: answer("product_access"),
    });
    expect(m.startResolve).not.toHaveBeenCalled();
  });

  it("passes the library's login redirect on without saving", async () => {
    const login = new Response(null, { status: 401 });
    m.authenticate.mockRejectedValue(login);
    await expect(post({ rules: rules() })).rejects.toBe(login);
    expect(m.saveRules).not.toHaveBeenCalled();
  });

  it("answers 422 with the validator's field errors", async () => {
    // The real saveRules validates first, without a Shopify call.
    const real = await vi.importActual<typeof import("../models/rules.server")>(
      "../models/rules.server",
    );
    m.saveRules.mockImplementation(real.saveRules);
    const bad = rules();
    bad.charts[CHART].match = [{ field: "tag", op: "is", value: " " }];
    expect(await result(post({ rules: bad, digest: "d1" }))).toEqual({
      status: 422,
      body: {
        fieldErrors: {
          [`charts.${CHART}.match.0.value`]: "Use 1 to 255 characters",
        },
      },
    });
    expect(m.startResolve).not.toHaveBeenCalled();
  });

  it("answers 422 for a body that isn't JSON", async () => {
    const real = await vi.importActual<typeof import("../models/rules.server")>(
      "../models/rules.server",
    );
    m.saveRules.mockImplementation(real.saveRules);
    expect(await result(post("not json"))).toEqual({
      status: 422,
      body: { fieldErrors: { "": "Must be display rules" } },
    });
  });

  it("answers 403 with the conditions Free can't add, whether the plan check failed, and the plans page", async () => {
    const fieldErrors = { [`charts.${CHART}.match.0`]: "On Standard and Pro" };
    m.getPlan.mockResolvedValue({ plan: "free", checkFailed: true });
    m.saveRules.mockRejectedValue(new RulesPlanError(fieldErrors));
    expect(await result(post({ rules: rules(), digest: "d1" }))).toEqual({
      status: 403,
      body: {
        ...answer("plan"),
        fieldErrors,
        checkFailed: true,
        plansUrl: PLANS,
      },
    });
    expect(m.startResolve).not.toHaveBeenCalled();
  });

  it("answers 409 when the rules changed since they loaded", async () => {
    m.saveRules.mockRejectedValue(new RulesConflictError("changed"));
    expect(await result(post({ rules: rules(), digest: "old" }))).toEqual({
      status: 409,
      body: answer("conflict"),
    });
    expect(m.startResolve).not.toHaveBeenCalled();
  });

  it("answers 502 and logs when Shopify fails, starting no resolve", async () => {
    m.saveRules.mockRejectedValue(
      new AdminApiError("Shopify refused the change", "[raw]"),
    );
    expect(await result(post({ rules: rules(), digest: "d1" }))).toEqual({
      status: 502,
      body: answer("shopify"),
    });
    expect(JSON.parse(logs[0])).toMatchObject({ shop: SHOP, detail: "[raw]" });
    expect(m.startResolve).not.toHaveBeenCalled();
  });

  it("lets an unexpected error through to the error boundary", async () => {
    m.saveRules.mockRejectedValue(new TypeError("bug"));
    await expect(post({ rules: rules(), digest: "d1" })).rejects.toThrow("bug");
  });
});
