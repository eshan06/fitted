import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiError } from "../models/admin.server";
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
}));
vi.mock("../shopify.server", () => ({
  authenticate: { admin: m.authenticate },
}));
vi.mock("../db.server", () => ({ default: {} }));
vi.mock("../models/admin.server", async (orig) => ({
  ...(await orig<typeof import("../models/admin.server")>()),
  canReadProducts: m.canReadProducts,
}));
vi.mock("../models/billing.server", async (orig) => ({
  ...(await orig<typeof import("../models/billing.server")>()),
  getPlan: m.getPlan,
}));
vi.mock("../models/chart.server", async (orig) => ({
  ...(await orig<typeof import("../models/chart.server")>()),
  chartPages: m.chartPages,
}));
// The real validator and errors; only the Shopify calls are stubbed.
vi.mock("../models/rules.server", async (orig) => ({
  ...(await orig<typeof import("../models/rules.server")>()),
  getRules: m.getRules,
  saveRules: m.saveRules,
  startResolve: m.startResolve,
}));
const { action, loader } = await import("./app.rules");
const { COPY } = await import("../components/rules/RulesEditor");
// §15: every refusal carries a code and the words the screen shows.
const answer = (code: string) => ({
  error: { code, message: COPY[code][1] },
});

const SHOP = "fitted-dev.myshopify.com";
const CHART = "gid://shopify/Metaobject/42";
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

const load = () =>
  loader({
    request: new Request("https://fitted.test/app/rules"),
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
    });
    expect(m.authenticate).toHaveBeenCalledOnce();
  });

  it("says rules need a chart when the store has none", async () => {
    m.chartPages.mockImplementation(() => pages([]));
    expect(await load()).toEqual({ mode: "empty" });
    expect(m.getRules).not.toHaveBeenCalled();
  });

  it("starts blank with the stored digest when the saved rules fail the checks", async () => {
    m.getRules.mockRejectedValue(
      new StoredRulesError({ [`charts.${CHART}.match.0.value`]: "Bad" }, "d0"),
    );
    expect(await load()).toMatchObject({
      mode: "edit",
      rules: { v: 1, order: [], charts: {} },
      digest: "d0",
      damaged: { [`charts.${CHART}.match.0.value`]: "Bad" },
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
      body: { ok: true },
    });
    expect(m.getPlan).toHaveBeenCalledWith(SHOP);
    expect(m.saveRules).toHaveBeenCalledWith(admin, rules(), "d1", "standard");
    expect(m.startResolve).toHaveBeenCalledExactlyOnceWith(SHOP, true);
  });

  it("answers a resent save like the first: the model returns the stored digest (§15)", async () => {
    await post({ rules: rules(), digest: "d1" });
    expect(await result(post({ rules: rules(), digest: "d1" }))).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(m.saveRules).toHaveBeenCalledTimes(2);
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

  it("answers 403 with the conditions Free can't add", async () => {
    const fieldErrors = { [`charts.${CHART}.match.0`]: "On Standard and Pro" };
    m.getPlan.mockResolvedValue({ plan: "free", checkFailed: false });
    m.saveRules.mockRejectedValue(new RulesPlanError(fieldErrors));
    expect(await result(post({ rules: rules(), digest: "d1" }))).toEqual({
      status: 403,
      body: { ...answer("plan"), fieldErrors },
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
