import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiError } from "../models/admin.server";
import {
  ChartConflictError,
  ChartNotFoundError,
  ChartValidationError,
  type ChartInput,
} from "../models/chart.server";

const m = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getChart: vi.fn(),
  updateChart: vi.fn(),
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  recordVersion: vi.fn(),
  shopTimeZone: vi.fn(),
}));
vi.mock("../shopify.server", () => ({
  authenticate: { admin: m.authenticate },
}));
vi.mock("../models/chart.server", async (orig) => ({
  ...(await orig<typeof import("../models/chart.server")>()),
  getChart: m.getChart,
  updateChart: m.updateChart,
}));
vi.mock("../models/chart-history.server", async (orig) => ({
  ...(await orig<typeof import("../models/chart-history.server")>()),
  listVersions: m.listVersions,
  getVersion: m.getVersion,
  recordVersion: m.recordVersion,
  shopTimeZone: m.shopTimeZone,
}));
const { action, loader } = await import("./app.charts.$id_.history");

const SHOP = "fitted-dev.myshopify.com";
const ID = "gid://shopify/Metaobject/42";
const admin = { graphql: vi.fn() };
const chart = (bust: [number, number] = [33, 34]): ChartInput => ({
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
        rows: [{ id: "s", cells: { bust } }],
      },
    ],
    measure: { steps: [] },
    words: { "t1.size": "Size", "t1.bust": "Bust", "t1.s.size": "S" },
  },
});
const stored = () => ({
  id: ID,
  handle: "c-abc123def4",
  status: "ACTIVE",
  updatedAt: "2026-11-19T00:00:05Z",
  name: "Women's tops",
  chart: chart(),
});
const version = (id: number, at: string, snapshot: ChartInput) => ({
  id,
  shop: SHOP,
  chartId: ID,
  createdAt: new Date(at),
  by: "Priya N.",
  summary: "Bust for S changed",
  snapshot,
});
const older = () =>
  version(1, "2026-11-08T23:18:00Z", {
    ...chart([33, 35]),
    importNote: "Check units",
  });

const load = (id = "42") =>
  loader({
    request: new Request(`https://fitted.test/app/charts/${id}/history`),
    params: { id },
  } as unknown as LoaderFunctionArgs);
const restore = (body: unknown, id = "42") =>
  action({
    request: new Request(`https://fitted.test/app/charts/${id}/history`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    params: { id },
  } as unknown as ActionFunctionArgs);
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
  m.authenticate.mockResolvedValue({
    admin,
    session: {
      shop: SHOP,
      onlineAccessInfo: {
        associated_user: { first_name: "Jordan", last_name: "Kim" },
      },
    },
  });
  m.getChart.mockResolvedValue(stored());
  m.shopTimeZone.mockResolvedValue("America/Los_Angeles");
  m.listVersions.mockResolvedValue([
    version(2, "2026-11-14T23:42:00Z", chart()),
    older(),
  ]);
  m.getVersion.mockResolvedValue(older());
  m.updateChart.mockResolvedValue(stored());
  m.recordVersion.mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("loading a chart's versions", () => {
  it("lists the shop's versions of the chart, newest first, in the store's time zone", async () => {
    expect(await load()).toEqual({
      name: "Women's tops",
      updatedAt: "2026-11-19T00:00:05Z",
      current: chart(),
      versions: [
        expect.objectContaining({ id: 2, when: "Nov 14, 2026 · 3:42 PM" }),
        {
          id: 1,
          when: "Nov 8, 2026 · 3:18 PM",
          by: "Priya N.",
          what: "Bust for S changed",
          chart: older().snapshot,
        },
      ],
    });
    expect(m.listVersions).toHaveBeenCalledWith(SHOP, ID);
    expect(m.getChart).toHaveBeenCalledWith(admin, ID);
  });

  it("answers 404 for a chart that isn't there", async () => {
    await expect(load("abc")).rejects.toMatchObject({ status: 404 });
    m.getChart.mockRejectedValue(new ChartNotFoundError());
    await expect(load()).rejects.toMatchObject({ status: 404 });
  });

  it("shows its error state when Shopify or the database fails, and logs why", async () => {
    m.listVersions.mockRejectedValue(new Error("connection refused"));
    expect(await result(load())).toEqual({
      status: 502,
      body: { error: true },
    });
    m.listVersions.mockResolvedValue([]);
    m.shopTimeZone.mockRejectedValue(new AdminApiError("failed", "HTTP 500"));
    expect((await result(load())).status).toBe(502);
    expect(JSON.parse(logs[0])).toMatchObject({ level: "error", shop: SHOP });
  });

  it("passes the login redirect on when there's no session", async () => {
    m.authenticate.mockRejectedValue(new Response(null, { status: 302 }));
    await expect(load()).rejects.toMatchObject({ status: 302 });
    expect(m.listVersions).not.toHaveBeenCalled();
  });
});

describe("restoring a version", () => {
  const LOADED = "2026-11-19T00:00:05Z";
  const send = (version: unknown = 1) =>
    restore({ version, updatedAt: LOADED });

  it("saves the old version over the chart it loaded, as a new version", async () => {
    expect(await send()).toEqual({ ok: true });
    // Looked up within this shop's chart, never by the id alone.
    expect(m.getVersion).toHaveBeenCalledWith(SHOP, ID, 1);
    // Sent with the updatedAt the page loaded, so a newer chart isn't
    // overwritten; an import's note is cleared, as by any save from the editor.
    expect(m.updateChart).toHaveBeenCalledWith(
      admin,
      ID,
      chart([33, 35]),
      LOADED,
    );
    expect(m.recordVersion).toHaveBeenCalledWith(
      SHOP,
      ID,
      chart([33, 35]),
      "Jordan K.",
      "Restored the Nov 8, 2026 version",
    );
    expect(m.recordVersion.mock.invocationCallOrder[0]).toBeGreaterThan(
      m.updateChart.mock.invocationCallOrder[0],
    );
  });

  it("refuses a version that isn't this shop's chart's (422), writing nothing", async () => {
    m.getVersion.mockResolvedValue(null);
    expect(await result(send(999))).toEqual({
      status: 422,
      body: { error: { message: expect.any(String), reload: true } },
    });
    expect((await result(restore(null))).status).toBe(422);
    expect(m.updateChart).not.toHaveBeenCalled();
    expect(m.recordVersion).not.toHaveBeenCalled();
  });

  it("says the chart didn't change when Shopify refuses or fails, with no version recorded", async () => {
    const cases: [unknown, number, object][] = [
      [new AdminApiError("failed", "HTTP 500"), 502, {}],
      [new ChartValidationError({ name: "Too long" }), 422, {}],
      // Changed since the page loaded: the page reloads before Try again.
      [new ChartConflictError("changed"), 409, { reload: true }],
    ];
    for (const [err, status, extra] of cases) {
      m.updateChart.mockRejectedValueOnce(err);
      const r = await result(send());
      expect(r.status).toBe(status);
      expect(r.body).toEqual({
        error: { message: expect.any(String), ...extra },
      });
    }
    expect(m.recordVersion).not.toHaveBeenCalled();
    // Shopify's raw error is logged, never shown.
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toMatchObject({ level: "error", shop: SHOP });
    m.updateChart.mockRejectedValue(new ChartNotFoundError());
    await expect(send()).rejects.toMatchObject({ status: 404 });
  });

  it("says history missed the restore when the version write fails", async () => {
    m.recordVersion.mockResolvedValue(false);
    expect(await send()).toEqual({ ok: true, missed: true });
  });

  it("answers 404 for a chart id that isn't one", async () => {
    await expect(restore({ version: 1 }, "abc")).rejects.toMatchObject({
      status: 404,
    });
    expect(m.getVersion).not.toHaveBeenCalled();
  });

  it("passes the login redirect on when there's no session", async () => {
    m.authenticate.mockRejectedValue(new Response(null, { status: 302 }));
    await expect(send()).rejects.toMatchObject({ status: 302 });
    expect(m.updateChart).not.toHaveBeenCalled();
  });
});
