import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError, AdminApiError } from "../models/admin.server";
import {
  ChartConflictError,
  ChartNotFoundError,
  ChartValidationError,
  type ChartInput,
} from "../models/chart.server";
import {
  SettingsReadWriteError,
  defaultSettings,
} from "../models/settings.server";

const m = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getPlan: vi.fn(),
  lastConfirmedPlan: vi.fn(),
  getSettings: vi.fn(),
  countChartProducts: vi.fn(),
  getChart: vi.fn(),
  createChart: vi.fn(),
  updateChart: vi.fn(),
  publishChart: vi.fn(),
  unpublishChart: vi.fn(),
  countActiveCharts: vi.fn(),
  canReadProducts: vi.fn(),
  pricingPlansUrl: vi.fn(),
  startResolve: vi.fn(),
  recordVersion: vi.fn(),
}));
vi.mock("../shopify.server", () => ({
  authenticate: { admin: m.authenticate },
}));
vi.mock("../models/admin.server", async (orig) => ({
  ...(await orig<typeof import("../models/admin.server")>()),
  canReadProducts: m.canReadProducts,
  pricingPlansUrl: m.pricingPlansUrl,
}));
vi.mock("../models/rules.server", () => ({ startResolve: m.startResolve }));
vi.mock("../models/chart-history.server", async (orig) => ({
  ...(await orig<typeof import("../models/chart-history.server")>()),
  recordVersion: m.recordVersion,
}));
vi.mock("../models/billing.server", async (orig) => ({
  ...(await orig<typeof import("../models/billing.server")>()),
  getPlan: m.getPlan,
  lastConfirmedPlan: m.lastConfirmedPlan,
}));
vi.mock("../models/settings.server", async (orig) => ({
  ...(await orig<typeof import("../models/settings.server")>()),
  getSettings: m.getSettings,
}));
// The real validator and errors; only the Shopify calls are stubbed.
vi.mock("../models/chart.server", async (orig) => ({
  ...(await orig<typeof import("../models/chart.server")>()),
  getChart: m.getChart,
  createChart: m.createChart,
  updateChart: m.updateChart,
  publishChart: m.publishChart,
  unpublishChart: m.unpublishChart,
  countActiveCharts: m.countActiveCharts,
  countChartProducts: m.countChartProducts,
}));
const { action, loader, shouldRevalidate } = await import("./app.charts.$id");

const SHOP = "fitted-dev.myshopify.com";
const ID = "gid://shopify/Metaobject/42";
const PLANS =
  "https://admin.shopify.com/store/fitted-dev/charges/fitted-5/pricing_plans";
const admin = { graphql: vi.fn() };
const redirect = vi.fn(
  (url: string) =>
    new Response(null, { status: 302, headers: { Location: url } }),
);
const chart = (): ChartInput => ({
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
        rows: [{ id: "s", cells: { bust: [33, 34] } }],
      },
    ],
    measure: { steps: [] },
    words: { "t1.size": "Size", "t1.bust": "Bust", "t1.s.size": "S" },
  },
});
const stored = (status: "ACTIVE" | "DRAFT") => ({
  id: ID,
  handle: "c-abc123def4",
  status,
  updatedAt: "2026-11-19T00:00:05Z",
  name: "Women's tops",
  chart: chart(),
});

const load = (id: string) =>
  loader({
    request: new Request(`https://fitted.test/app/charts/${id}`),
    params: { id },
  } as unknown as LoaderFunctionArgs);
const post = (id: string, body: unknown) =>
  action({
    request: new Request(`https://fitted.test/app/charts/${id}`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    params: { id },
  } as unknown as ActionFunctionArgs);
const save = (status: string, extra: object = {}) =>
  post("42", {
    chart: chart(),
    status,
    updatedAt: "2026-11-19T00:00:05Z",
    ...extra,
  });
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
  vi.stubEnv("SHOPIFY_API_SECRET", "test-secret");
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => logs.push(line));
  m.authenticate.mockResolvedValue({
    admin,
    session: {
      shop: SHOP,
      onlineAccessInfo: {
        associated_user: { first_name: "Priya", last_name: "Nair" },
      },
    },
    redirect,
  });
  m.recordVersion.mockResolvedValue(true);
  m.getPlan.mockResolvedValue({ plan: "free", checkFailed: false });
  m.countActiveCharts.mockResolvedValue(2);
  m.pricingPlansUrl.mockResolvedValue(PLANS);
  m.getChart.mockResolvedValue(stored("DRAFT"));
  m.getSettings.mockResolvedValue({
    settings: defaultSettings("en"),
    digest: null,
    shopId: "gid://shopify/Shop/1",
    primaryLocale: "en",
  });
  m.lastConfirmedPlan.mockResolvedValue({
    plan: "pro",
    yearly: false,
    at: null,
  });
  m.countChartProducts.mockResolvedValue({
    [ID]: { count: 148, atLeast: false },
  });
  m.updateChart.mockResolvedValue(stored("DRAFT"));
  m.canReadProducts.mockResolvedValue(true);
  m.startResolve.mockResolvedValue(undefined);
  redirect.mockImplementation(
    (url) => new Response(null, { status: 302, headers: { Location: url } }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("loading the editor", () => {
  it("loads the chart by its numeric id", async () => {
    m.getChart.mockResolvedValue(stored("ACTIVE"));
    expect(await load("42")).toEqual({
      mode: "edit",
      stored: stored("ACTIVE"),
      planAtLoad: { plan: "pro", yearly: false, at: null },
      look: {
        settings: defaultSettings("en"),
        primaryLocale: "en",
        plan: "pro",
        words: expect.objectContaining({ title: "Size guide" }),
        products: { count: 148, atLeast: false },
      },
    });
    expect(m.getChart).toHaveBeenCalledWith(admin, ID);
  });

  it("reads the preview's settings and plan for the session's shop only (§7, §8)", async () => {
    await load("42");
    expect(m.getSettings).toHaveBeenCalledWith(admin);
    expect(m.lastConfirmedPlan).toHaveBeenCalledWith(SHOP);
    expect(m.countChartProducts).toHaveBeenCalledWith(admin, [ID]);
    expect(await load("new")).toMatchObject({
      mode: "new",
      planAtLoad: { plan: "pro", yearly: false, at: null },
      look: {
        settings: defaultSettings("en"),
        primaryLocale: "en",
        plan: "pro",
        words: expect.objectContaining({ title: "Size guide" }),
      },
    });
    expect(m.countChartProducts).toHaveBeenCalledTimes(1);
  });

  it("answers 502 when the preview's settings or count can't be read", async () => {
    const failed = {
      status: 502,
      body: {
        mode: "error",
        error: {
          code: "shopify",
          message:
            "Fitted couldn't reach your store just now. Nothing about the chart has changed, and shoppers still see it as before.",
        },
      },
    };
    m.getSettings.mockRejectedValue(
      new SettingsReadWriteError("Admin API returned 503: null"),
    );
    expect(await result(load("42"))).toEqual(failed);
    expect(await result(load("new"))).toEqual(failed);
    expect(JSON.parse(logs[0])).toMatchObject({
      level: "error",
      shop: SHOP,
      msg: "Admin API returned 503: null",
    });
    m.getSettings.mockResolvedValue({
      settings: defaultSettings("en"),
      digest: null,
      shopId: "gid://shopify/Shop/1",
      primaryLocale: "en",
    });
    m.countChartProducts.mockRejectedValue(
      new AdminApiError("Shopify request failed", "count detail"),
    );
    expect(await result(load("42"))).toEqual(failed);
  });

  it("mints a fresh handle for a new chart", async () => {
    const a = (await load("new")) as { mode: string; handle: string };
    const b = (await load("new")) as { handle: string };
    expect(a.mode).toBe("new");
    expect(a.handle).toMatch(/^c-[a-z0-9]{10}$/);
    expect(b.handle).not.toBe(a.handle);
    expect(m.getChart).not.toHaveBeenCalled();
  });

  it("starts a new chart from the picker's template, else blank", async () => {
    const from = async (q: string) =>
      (
        (await loader({
          request: new Request(`https://fitted.test/app/charts/new${q}`),
          params: { id: "new" },
        } as unknown as LoaderFunctionArgs)) as { template: string }
      ).template;
    expect(await from("?template=bras_swimwear")).toBe("bras_swimwear");
    expect(await load("new")).toMatchObject({ template: "blank" });
    for (const q of ["?template=capes", "?template=__proto__", "?template="])
      expect(await from(q)).toBe("blank");
  });

  it("answers 404 for a malformed id or a chart that's gone", async () => {
    for (const id of ["abc", "gid://shopify/Metaobject/1", "1.5"]) {
      const err = await load(id).catch((e) => e);
      expect(err).toBeInstanceOf(Response);
      expect(err.status).toBe(404);
    }
    m.getChart.mockRejectedValue(new ChartNotFoundError());
    expect((await load("42").catch((e) => e)).status).toBe(404);
  });

  it("answers 502 when Shopify fails, logging the detail but not returning it", async () => {
    m.getChart.mockRejectedValue(
      new AdminApiError("Shopify request failed", "secret detail"),
    );
    const r = await result(load("42"));
    expect(r).toEqual({
      status: 502,
      body: {
        mode: "error",
        error: {
          code: "shopify",
          message:
            "Fitted couldn't reach your store just now. Nothing about the chart has changed, and shoppers still see it as before.",
        },
      },
    });
    expect(JSON.parse(logs[0])).toMatchObject({
      level: "error",
      shop: SHOP,
      route: "app.charts.$id",
      detail: "secret detail",
    });
  });

  it("answers 403 saying so when Shopify refuses the staff member the chart (§15)", async () => {
    m.getChart.mockRejectedValue(
      new AccessDeniedError("Access denied for metaobject field."),
    );
    expect(await result(load("42"))).toEqual({
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
      route: "app.charts.$id",
      detail: "Access denied for metaobject field.",
    });
  });

  it("passes the login redirect on when there's no session", async () => {
    const login = new Response(null, { status: 302 });
    m.authenticate.mockRejectedValue(login);
    await expect(load("42")).rejects.toBe(login);
    await expect(save("DRAFT")).rejects.toBe(login);
    expect(m.getChart).not.toHaveBeenCalled();
    expect(m.updateChart).not.toHaveBeenCalled();
  });
});

describe("creating a chart", () => {
  it("creates by the minted handle and opens the new chart", async () => {
    m.createChart.mockResolvedValue(stored("DRAFT"));
    // The editor opens it once the save bar is hidden (Editor).
    expect(
      await result(post("new", { handle: "c-abc123def4", chart: chart() })),
    ).toEqual({ status: 200, body: { created: "42" } });
    expect(m.createChart).toHaveBeenCalledWith(admin, "c-abc123def4", chart());
    expect(m.recordVersion).toHaveBeenCalledWith(
      SHOP,
      ID,
      chart(),
      "Priya N.",
      "Created from the Tops template",
    );
  });

  it("opens the new chart saying history missed it when the version write fails", async () => {
    m.createChart.mockResolvedValue(stored("DRAFT"));
    m.recordVersion.mockResolvedValue(false);
    expect(
      await result(post("new", { handle: "c-abc123def4", chart: chart() })),
    ).toEqual({ status: 200, body: { created: "42", historyMissed: true } });
  });

  it("sends a replayed create to the same chart", async () => {
    // createChart answers a repeat of its handle with the chart it made (chart.test.ts).
    m.createChart.mockResolvedValue(stored("DRAFT"));
    const body = { handle: "c-abc123def4", chart: chart() };
    const first = await result(post("new", body));
    expect(await result(post("new", body))).toEqual(first);
    expect(m.createChart.mock.calls[1]).toEqual(m.createChart.mock.calls[0]);
  });

  it("refuses an invalid chart or body before calling Shopify (422)", async () => {
    const bad = { ...chart(), name: "" };
    expect(
      await result(post("new", { handle: "c-abc123def4", chart: bad })),
    ).toEqual({
      status: 422,
      body: {
        fieldErrors: expect.objectContaining({ name: expect.any(String) }),
      },
    });
    expect((await result(post("new", "not json"))).status).toBe(422);
    expect((await result(post("new", [1]))).status).toBe(422);
    expect(m.createChart).not.toHaveBeenCalled();
  });
});

describe("saving a chart", () => {
  it("saves with the updatedAt the editor loaded", async () => {
    expect(await save("DRAFT")).toEqual({ ok: true });
    expect(m.updateChart).toHaveBeenCalledWith(
      admin,
      ID,
      chart(),
      "2026-11-19T00:00:05Z",
    );
    expect(m.publishChart).not.toHaveBeenCalled();
    expect(m.unpublishChart).not.toHaveBeenCalled();
    // After the chart saved, as the staff member who saved it.
    expect(m.recordVersion).toHaveBeenCalledWith(SHOP, ID, chart(), "Priya N.");
    expect(m.recordVersion.mock.invocationCallOrder[0]).toBeGreaterThan(
      m.updateChart.mock.invocationCallOrder[0],
    );
  });

  it("says the chart saved but history missed it when the version write fails", async () => {
    m.recordVersion.mockResolvedValue(false);
    // The save reloads the chart, so the note travels in the address.
    for (const status of ["DRAFT", "ACTIVE"]) {
      const res = (await save(status)) as Response;
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/app/charts/42?history=missed");
    }
    // Edits saved but the status didn't: no reload, so the answer says it.
    m.publishChart.mockRejectedValue(new AdminApiError("failed", "HTTP 500"));
    const r = await result(save("ACTIVE"));
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ historyMissed: true });
  });

  it("records no version when Shopify refuses the save", async () => {
    m.updateChart.mockRejectedValue(new ChartConflictError("changed"));
    expect((await result(save("DRAFT"))).status).toBe(409);
    expect(m.recordVersion).not.toHaveBeenCalled();
  });

  it("publishes after saving when the plan allows another Active chart", async () => {
    expect(await save("ACTIVE")).toEqual({ ok: true });
    expect(m.getPlan).toHaveBeenCalledWith(SHOP);
    expect(m.publishChart).toHaveBeenCalledWith(admin, ID);
  });

  it("refuses Free's fourth Active chart before writing anything (403)", async () => {
    m.countActiveCharts.mockResolvedValue(3);
    const r = await result(save("ACTIVE", { shop: "other.myshopify.com" }));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: {
        code: "plan_limit",
        message: expect.any(String),
        limit: 3,
        published: 3,
        checkFailed: false,
        plansUrl: PLANS,
      },
    });
    // The plan and its page are the session's shop's, never one the browser sent.
    expect(m.getPlan).toHaveBeenCalledWith(SHOP);
    expect(m.pricingPlansUrl).toHaveBeenCalledWith(admin, SHOP);
    expect(m.updateChart).not.toHaveBeenCalled();
    expect(m.publishChart).not.toHaveBeenCalled();
  });

  it("lets paid plans past three, and never counts an already Active chart", async () => {
    m.countActiveCharts.mockResolvedValue(10);
    m.getPlan.mockResolvedValue({ plan: "standard", checkFailed: false });
    expect(await save("ACTIVE")).toEqual({ ok: true });
    m.getPlan.mockResolvedValue({ plan: "free", checkFailed: false });
    m.getChart.mockResolvedValue(stored("ACTIVE"));
    m.updateChart.mockResolvedValue(stored("ACTIVE"));
    m.publishChart.mockClear();
    expect(await save("ACTIVE")).toEqual({ ok: true });
    expect(m.publishChart).not.toHaveBeenCalled();
  });

  it("unpublishes when set to Draft", async () => {
    m.updateChart.mockResolvedValue(stored("ACTIVE"));
    expect(await save("DRAFT")).toEqual({ ok: true });
    expect(m.unpublishChart).toHaveBeenCalledWith(admin, ID);
    expect(m.getPlan).not.toHaveBeenCalled();
  });

  it("starts a merchant resolve for the session's shop once the status changes, so products follow (§6)", async () => {
    let published = () => {};
    m.publishChart.mockReturnValue(
      new Promise<void>((r) => (published = () => r())),
    );
    // The job runs in the background: one that never ends can't hold the save.
    m.startResolve.mockReturnValue(new Promise(() => {}));
    const saving = save("ACTIVE", { shop: "other.myshopify.com" });
    await vi.waitFor(() => expect(m.publishChart).toHaveBeenCalled());
    expect(m.startResolve).not.toHaveBeenCalled();
    published();
    expect(await saving).toEqual({ ok: true });
    expect(m.startResolve).toHaveBeenCalledExactlyOnceWith(SHOP, true);
    m.startResolve.mockClear();
    m.updateChart.mockResolvedValue(stored("ACTIVE"));
    expect(await save("DRAFT")).toEqual({ ok: true });
    expect(m.unpublishChart).toHaveBeenCalled();
    expect(m.startResolve).toHaveBeenCalledExactlyOnceWith(SHOP, true);
  });

  it("starts no resolve when the status stays or doesn't change", async () => {
    await save("DRAFT");
    m.publishChart.mockRejectedValueOnce(new AdminApiError("x", "y"));
    expect((await result(save("ACTIVE"))).status).toBe(502);
    m.publishChart.mockRejectedValueOnce(
      new ChartValidationError({ name: "Add a name" }),
    );
    expect((await result(save("ACTIVE"))).status).toBe(422);
    m.countActiveCharts.mockResolvedValue(3);
    expect((await result(save("ACTIVE"))).status).toBe(403);
    expect(m.startResolve).not.toHaveBeenCalled();
    // Only a status change needs product access.
    expect(m.canReadProducts).toHaveBeenCalledTimes(2);
  });

  it("keeps the status when the staff member can't read products, since the resolve runs with the offline token (403)", async () => {
    m.canReadProducts.mockResolvedValue(false);
    m.updateChart.mockResolvedValue({
      ...stored("DRAFT"),
      updatedAt: "2026-11-19T00:00:09Z",
    });
    expect(await result(save("ACTIVE"))).toEqual({
      status: 403,
      body: {
        error: {
          code: "product_access",
          message:
            "Your edits were saved, but the chart is still a Draft. Publishing or unpublishing a chart changes which products show it, which needs the Products permission on your staff account. Ask the store owner to give you Products access in Settings › Users, then save again.",
        },
        updatedAt: "2026-11-19T00:00:09Z",
      },
    });
    expect(m.canReadProducts).toHaveBeenCalledWith(admin);
    expect(m.updateChart).toHaveBeenCalled();
    expect(m.publishChart).not.toHaveBeenCalled();
    m.updateChart.mockResolvedValue(stored("ACTIVE"));
    expect((await result(save("DRAFT"))).body).toMatchObject({
      error: {
        code: "product_access",
        message: expect.stringMatching(
          /^Your edits were saved, .* Published\./,
        ),
      },
    });
    expect(m.unpublishChart).not.toHaveBeenCalled();
    expect(m.startResolve).not.toHaveBeenCalled();
  });

  it("says so when Shopify refuses the staff member the publish itself (403, §15)", async () => {
    m.publishChart.mockRejectedValue(
      new AccessDeniedError("Access denied for metaobjectUpdate field."),
    );
    m.updateChart.mockResolvedValue({
      ...stored("DRAFT"),
      updatedAt: "2026-11-19T00:00:09Z",
    });
    expect(await result(save("ACTIVE"))).toMatchObject({
      status: 403,
      body: {
        error: {
          code: "product_access",
          message: expect.stringMatching(
            /^Your edits were saved, but the chart is still a Draft\. /,
          ),
        },
        updatedAt: "2026-11-19T00:00:09Z",
      },
    });
    expect(m.startResolve).not.toHaveBeenCalled();
  });

  it("says the status didn't change when product access can't be checked (502)", async () => {
    m.canReadProducts.mockRejectedValueOnce(
      new AdminApiError("Shopify request failed", "raw detail"),
    );
    const r = await result(save("ACTIVE"));
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({
      error: {
        code: "status",
        message:
          "Your edits were saved, but the chart is still a Draft. Change its status and save again.",
      },
    });
    expect(JSON.stringify(r.body)).not.toContain("raw detail");
    expect(JSON.parse(logs[0]).detail).toBe("raw detail");
    // Re-auth passes through, as from any other Shopify call.
    const reauth = new Response(null, { status: 401 });
    m.canReadProducts.mockRejectedValueOnce(reauth);
    await expect(save("ACTIVE")).rejects.toBe(reauth);
    expect(m.publishChart).not.toHaveBeenCalled();
    expect(m.startResolve).not.toHaveBeenCalled();
  });

  it("says so when the edits saved but the status didn't change (502)", async () => {
    m.publishChart.mockRejectedValue(new AdminApiError("x", "raw detail"));
    m.updateChart.mockResolvedValue({
      ...stored("DRAFT"),
      updatedAt: "2026-11-19T00:00:09Z",
    });
    const r = await result(save("ACTIVE"));
    expect(r.status).toBe(502);
    expect(r.body).toEqual({
      error: {
        code: "status",
        message:
          "Your edits were saved, but the chart is still a Draft. Change its status and save again.",
      },
      // A failed action doesn't reload the chart, so the next save needs this.
      updatedAt: "2026-11-19T00:00:09Z",
    });
    expect(JSON.stringify(r.body)).not.toContain("raw detail");
    expect(JSON.parse(logs[0]).detail).toBe("raw detail");
  });

  it("says a failed unpublish leaves the chart Published", async () => {
    m.updateChart.mockResolvedValue(stored("ACTIVE"));
    m.unpublishChart.mockRejectedValue(new AdminApiError("x", "y"));
    const r = await result(save("DRAFT"));
    expect(r.body).toMatchObject({
      error: { message: expect.stringContaining("still Published") },
    });
  });

  it("says when Free's limit comes from a plan it couldn't check", async () => {
    m.countActiveCharts.mockResolvedValue(3);
    m.getPlan.mockResolvedValue({ plan: "free", checkFailed: true });
    const r = await result(save("ACTIVE"));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({
      error: {
        message: expect.stringMatching(/^Fitted couldn't check your plan/),
        checkFailed: true,
      },
    });
  });

  it("still names Free's limit when the plans link can't be read, logging why", async () => {
    m.countActiveCharts.mockResolvedValue(3);
    m.pricingPlansUrl.mockRejectedValue(new AdminApiError("down", "detail"));
    const r = await result(save("ACTIVE"));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { code: "plan_limit" } });
    expect(
      (r.body as { error: { plansUrl?: string } }).error.plansUrl,
    ).toBeUndefined();
    expect(logs.join("\n")).toContain("detail");
    expect(m.updateChart).not.toHaveBeenCalled();
  });

  it("maps each failure to its status (§15)", async () => {
    m.updateChart.mockRejectedValueOnce(
      new ChartConflictError("This chart changed since you opened it"),
    );
    expect(await result(save("DRAFT"))).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "This chart changed since you opened it",
        },
      },
    });
    m.updateChart.mockRejectedValueOnce(new AdminApiError("x", "raw detail"));
    const r = await result(save("DRAFT"));
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: { code: "shopify" } });
    expect(JSON.stringify(r.body)).not.toContain("raw detail");
    m.updateChart.mockRejectedValueOnce(new ChartNotFoundError());
    expect((await save("DRAFT").catch((e) => e)).status).toBe(404);
    m.updateChart.mockRejectedValueOnce(new Error("boom"));
    await expect(save("DRAFT")).rejects.toThrow("boom");
  });

  it("refuses an invalid chart or status before calling Shopify (422)", async () => {
    expect(await result(save("LIVE"))).toEqual({
      status: 422,
      body: { fieldErrors: { status: "Pick Published or Draft" } },
    });
    const r = await result(
      post("42", { chart: { ...chart(), template: "capes" }, status: "DRAFT" }),
    );
    expect(r.body).toEqual({ fieldErrors: { template: "Pick a template" } });
    expect(m.getChart).not.toHaveBeenCalled();
    expect(m.updateChart).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed id before reading the body", async () => {
    expect((await post("x1", {}).catch((e) => e)).status).toBe(404);
  });
});

// Shopify Files behind the fake admin: the staged upload, fileCreate and the
// image's status, with the staged target's POST on `fetch`.
const IMAGE_URL = "https://cdn.shopify.com/s/files/1/1/files/tops.png?v=1";
function fakeFiles({ statuses = ["READY"], target = 204 } = {}) {
  const calls: { query: string; variables?: Record<string, unknown> }[] = [];
  const answer = (q: string) =>
    q.includes("FittedImageStage")
      ? {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: "https://storage.test/upload",
                resourceUrl: "https://storage.test/tmp/tops.png",
                parameters: [{ name: "key", value: "tmp/tops.png" }],
              },
            ],
            userErrors: [],
          },
        }
      : q.includes("FittedImageCreate")
        ? {
            fileCreate: {
              files: [{ id: "gid://shopify/MediaImage/7" }],
              userErrors: [],
            },
          }
        : {
            node: {
              fileStatus: statuses.length > 1 ? statuses.shift() : statuses[0],
              image: { url: IMAGE_URL },
            },
          };
  admin.graphql.mockImplementation(
    async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: opts?.variables });
      return Response.json({ data: answer(query) });
    },
  );
  const sent = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status: target }));
  return { calls, sent };
}
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const image = (name = "tops.png", bytes = PNG, size = bytes.length) => {
  const b = new Uint8Array(size);
  b.set(bytes);
  return new File([b], name);
};
const postImage = (file: File, id = "42") => {
  const body = new FormData();
  body.append("file", file);
  return result(
    action({
      request: new Request(`https://fitted.test/app/charts/${id}`, {
        method: "POST",
        body,
      }),
      params: { id },
    } as unknown as ActionFunctionArgs),
  );
};
const notImage = {
  status: 422,
  body: { fieldErrors: { measureImage: "Use a PNG or JPG up to 20 MB." } },
};

describe("uploading a How to measure image", () => {
  it("doesn't read the chart again after an upload, so a new chart keeps its handle", () => {
    const after = (
      formEncType: string,
      defaultShouldRevalidate = true,
      formMethod = "POST",
    ) =>
      shouldRevalidate({
        formEncType,
        defaultShouldRevalidate,
        formMethod,
      } as Parameters<typeof shouldRevalidate>[0]);
    expect(after("multipart/form-data")).toBe(false);
    // Nor after a discard.
    expect(after("application/x-www-form-urlencoded", true, "DELETE")).toBe(
      false,
    );
    expect(after("application/json")).toBe(true);
    expect(after("application/json", false)).toBe(false);
  });

  it("sends a PNG or JPG to Shopify Files and answers its id and address", async () => {
    const { calls, sent } = fakeFiles();
    expect(await postImage(image("My tops (1).png"))).toEqual({
      status: 200,
      body: {
        image: {
          id: "gid://shopify/MediaImage/7",
          url: IMAGE_URL,
          sig: expect.any(String),
        },
      },
    });
    expect(calls[0].variables).toEqual({
      input: [
        {
          resource: "IMAGE",
          filename: "My-tops-1-.png",
          mimeType: "image/png",
          httpMethod: "POST",
          fileSize: "8",
        },
      ],
    });
    expect(calls[1].variables).toEqual({
      files: [
        {
          originalSource: "https://storage.test/tmp/tops.png",
          contentType: "IMAGE",
        },
      ],
    });
    expect(sent.mock.calls[0][0]).toBe("https://storage.test/upload");
    // A new chart uploads too, before it's created; no chart is touched.
    fakeFiles();
    const jpg = image("tops.jpeg", [0xff, 0xd8, 0xff, 0xe0]);
    expect((await postImage(jpg, "new")).status).toBe(200);
    expect(m.updateChart).not.toHaveBeenCalled();
    expect(m.createChart).not.toHaveBeenCalled();
  });

  it("refuses an upload without a session before reading it", async () => {
    m.authenticate.mockRejectedValue(new Response(null, { status: 401 }));
    const { sent } = fakeFiles();
    await expect(postImage(image())).rejects.toBeInstanceOf(Response);
    expect(admin.graphql).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
  });

  it("refuses a GIF, a WebP, a renamed file or one over 20 MB by its bytes (422)", async () => {
    fakeFiles();
    expect(await postImage(image("tops.png", GIF))).toEqual(notImage);
    expect(await postImage(image("tops.gif", GIF))).toEqual(notImage);
    expect(await postImage(image("tops.webp", PNG))).toEqual(notImage);
    expect(await postImage(image("tops.jpg", PNG))).toEqual(notImage);
    const big = 20 * 1024 * 1024;
    expect(await postImage(image("big.png", PNG, big + 1))).toEqual(notImage);
    // Past the body cap, the rest isn't read at all.
    expect(await postImage(image("big.png", PNG, big + 200_000))).toEqual(
      notImage,
    );
    expect(admin.graphql).not.toHaveBeenCalled();
  });

  it("says Shopify didn't answer when the upload fails, logging why (502)", async () => {
    const failed = {
      status: 502,
      body: {
        error: {
          code: "upload",
          message: "Shopify didn't answer, so the chart has no drawing yet.",
        },
      },
    };
    fakeFiles({ target: 500 });
    expect(await postImage(image())).toEqual(failed);
    expect(JSON.parse(logs[0])).toMatchObject({
      level: "error",
      msg: "The image didn't reach Shopify",
      shop: SHOP,
    });
    fakeFiles({ statuses: ["FAILED"] });
    expect(await postImage(image())).toEqual(failed);
  });

  it("waits while Shopify processes the image", async () => {
    const { calls } = fakeFiles({
      statuses: ["UPLOADED", "PROCESSING", "READY"],
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const answer = postImage(image());
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    expect((await answer).body).toEqual({
      image: {
        id: "gid://shopify/MediaImage/7",
        url: IMAGE_URL,
        sig: expect.any(String),
      },
    });
    const polls = calls.filter((c) => c.query.includes("FittedImageFile"));
    expect(polls).toHaveLength(3);
  });
});

describe("discarding an image the editor let go", () => {
  const FILE = "gid://shopify/MediaImage/7";
  // The sig an upload of MediaImage/7 answers, for this shop.
  const sigFor = async () => {
    const { sent } = fakeFiles();
    const { body } = await postImage(image());
    sent.mockRestore();
    admin.graphql.mockReset();
    return (body as { image: { sig: string } }).image.sig;
  };
  const drop = (fields: Record<string, string>, id = "42") =>
    result(
      action({
        request: new Request(`https://fitted.test/app/charts/${id}`, {
          method: "DELETE",
          body: new URLSearchParams(fields),
        }),
        params: { id },
      } as unknown as ActionFunctionArgs),
    );
  // A chart as Shopify lists it, holding `image` as its How to measure image.
  const node = (image: string, valid = true) => ({
    id: ID,
    handle: "c-abc123def4",
    type: "$app:chart",
    updatedAt: "2026-11-19T00:00:05Z",
    capabilities: { publishable: { status: "DRAFT" } },
    name: { value: "Women's tops" },
    template: { value: valid ? "tops" : "nope" },
    content: { jsonValue: chart().content },
    measureImage: { value: image, reference: null },
    importNote: null,
  });
  // Shopify Files deletes, after listing the `saved` charts a page at a time.
  const deleted = (userErrors: object[] = [], saved: object[][] = [[]]) =>
    admin.graphql.mockImplementation(
      async (query: string, opts?: { variables?: { after?: string } }) => {
        if (!query.includes("ChartList"))
          return Response.json({
            data: {
              fileDelete: {
                deletedFileIds: userErrors.length ? null : [FILE],
                userErrors,
              },
            },
          });
        const page = Number(opts?.variables?.after ?? 0);
        const more = page + 1 < saved.length;
        return Response.json({
          data: {
            metaobjects: {
              nodes: saved[page],
              pageInfo: {
                hasNextPage: more,
                endCursor: more ? String(page + 1) : null,
              },
            },
          },
        });
      },
    );
  const deletes = () =>
    admin.graphql.mock.calls.filter(([q]) => q.includes("fileDelete"));

  it("deletes a file Fitted uploaded from Shopify Files", async () => {
    const sig = await sigFor();
    deleted();
    expect(await drop({ id: FILE, sig })).toEqual({
      status: 200,
      body: { discarded: FILE },
    });
    const [[, opts]] = deletes();
    expect(opts.variables).toEqual({ ids: [FILE] });
    // A new chart's editor discards too; no chart is touched.
    deleted();
    expect((await drop({ id: FILE, sig }, "new")).status).toBe(200);
    expect(m.updateChart).not.toHaveBeenCalled();
  });

  it("answers done again when the file is already gone", async () => {
    const sig = await sigFor();
    deleted([
      { field: ["fileIds"], message: "gone", code: "FILE_DOES_NOT_EXIST" },
    ]);
    expect(await drop({ id: FILE, sig })).toEqual({
      status: 200,
      body: { discarded: FILE },
    });
  });

  it("refuses without a session before reading the body", async () => {
    m.authenticate.mockRejectedValue(new Response(null, { status: 401 }));
    await expect(drop({ id: FILE, sig: "x" })).rejects.toBeInstanceOf(Response);
    expect(admin.graphql).not.toHaveBeenCalled();
  });

  it("never deletes a file Fitted didn't upload for this shop (403)", async () => {
    const sig = await sigFor();
    const refused = {
      status: 403,
      body: {
        error: {
          code: "not_fitted",
          message: "Fitted didn't upload this file.",
        },
      },
    };
    // Another file, a made-up sig, and this file's sig from another shop.
    expect(await drop({ id: "gid://shopify/MediaImage/8", sig })).toEqual(
      refused,
    );
    expect(await drop({ id: FILE, sig: "made-up" })).toEqual(refused);
    m.authenticate.mockResolvedValue({
      admin,
      session: { shop: "other.myshopify.com" },
      redirect,
    });
    expect(await drop({ id: FILE, sig })).toEqual(refused);
    expect(admin.graphql).not.toHaveBeenCalled();
  });

  it("refuses a sig over an hour old, without calling Shopify (403)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
    const sig = await sigFor();
    deleted();
    vi.setSystemTime(new Date("2026-11-20T10:59:00Z"));
    expect((await drop({ id: FILE, sig })).status).toBe(200);
    admin.graphql.mockClear();
    vi.setSystemTime(new Date("2026-11-20T11:00:01Z"));
    expect(await drop({ id: FILE, sig })).toEqual({
      status: 403,
      body: {
        error: {
          code: "expired",
          message:
            "This upload is over an hour old, so Fitted keeps it. Delete it in Settings > Files if you don't need it.",
        },
      },
    });
    // Nor can its issue time be moved on: the sig covers it.
    const now = String(Math.floor(Date.now() / 1000));
    const moved = await drop({ id: FILE, sig: sig.replace(/^\d+/, now) });
    expect(moved).toMatchObject({
      status: 403,
      body: { error: { code: "not_fitted" } },
    });
    expect(admin.graphql).not.toHaveBeenCalled();
  });

  it("deletes nothing when the charts can't be read, logging why (502)", async () => {
    const sig = await sigFor();
    admin.graphql.mockResolvedValue(Response.json({ errors: [{}] }));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const answer = drop({ id: FILE, sig });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await answer).toEqual({
      status: 502,
      body: {
        error: { code: "shopify", message: "Shopify didn't delete the image." },
      },
    });
    expect(deletes()).toHaveLength(0);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ shop: SHOP });
  });

  it("never deletes an image a chart has saved, on any page of charts (409)", async () => {
    const sig = await sigFor();
    const kept = {
      status: 409,
      body: {
        error: {
          code: "saved",
          message: "A chart uses this image, so Fitted keeps it.",
        },
      },
    };
    const other = node("gid://shopify/MediaImage/8");
    deleted([], [[other], [other, node(FILE)]]);
    expect(await drop({ id: FILE, sig })).toEqual(kept);
    // A chart Fitted can't read in full still holds its image.
    deleted([], [[node(FILE, false)]]);
    expect(await drop({ id: FILE, sig })).toEqual(kept);
    expect(deletes()).toHaveLength(0);
    // Saved on no chart: deleted.
    deleted([], [[other]]);
    expect((await drop({ id: FILE, sig })).status).toBe(200);
    expect(deletes()).toHaveLength(1);
  });

  it("refuses a discard without an id and sig (422)", async () => {
    expect(await drop({ id: FILE })).toEqual({
      status: 422,
      body: { fieldErrors: { id: "Must be an uploaded image" } },
    });
    expect(admin.graphql).not.toHaveBeenCalled();
  });

  it("says Shopify didn't delete it, logging why (502)", async () => {
    const sig = await sigFor();
    deleted([{ field: ["fileIds"], message: "locked", code: "INVALID" }]);
    expect(await drop({ id: FILE, sig })).toEqual({
      status: 502,
      body: {
        error: { code: "shopify", message: "Shopify didn't delete the image." },
      },
    });
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      level: "error",
      shop: SHOP,
    });
  });
});
