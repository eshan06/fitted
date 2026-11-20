import type { LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiError } from "../models/admin.server";
import { ChartNotFoundError, type ChartInput } from "../models/chart.server";

const m = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getChart: vi.fn(),
  listVersions: vi.fn(),
  shopTimeZone: vi.fn(),
}));
vi.mock("../shopify.server", () => ({
  authenticate: { admin: m.authenticate },
}));
vi.mock("../models/chart.server", async (orig) => ({
  ...(await orig<typeof import("../models/chart.server")>()),
  getChart: m.getChart,
}));
vi.mock("../models/chart-history.server", async (orig) => ({
  ...(await orig<typeof import("../models/chart-history.server")>()),
  listVersions: m.listVersions,
  shopTimeZone: m.shopTimeZone,
}));
const { loader } = await import("./app.charts.$id_.history");

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
const version = (id: number, at: string, snapshot: ChartInput) => ({
  id,
  shop: SHOP,
  chartId: ID,
  createdAt: new Date(at),
  by: "Priya N.",
  summary: "Bust for S changed",
  snapshot,
});

const load = (id = "42") =>
  loader({
    request: new Request(`https://fitted.test/app/charts/${id}/history`),
    params: { id },
  } as unknown as LoaderFunctionArgs);
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
  m.getChart.mockResolvedValue({
    id: ID,
    handle: "c-abc123def4",
    status: "ACTIVE",
    updatedAt: "2026-11-19T00:00:05Z",
    name: "Women's tops",
    chart: chart(),
  });
  m.shopTimeZone.mockResolvedValue("America/Los_Angeles");
  m.listVersions.mockResolvedValue([
    version(2, "2026-11-14T23:42:00Z", chart()),
    version(1, "2026-11-08T23:18:00Z", chart([33, 35])),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("loading a chart's versions", () => {
  it("lists the shop's versions of the chart, newest first, in the store's time zone", async () => {
    expect(await load()).toEqual({
      name: "Women's tops",
      limit: 30,
      current: chart(),
      versions: [
        expect.objectContaining({ id: 2, when: "Nov 14, 2026 · 3:42 PM" }),
        {
          id: 1,
          when: "Nov 8, 2026 · 3:18 PM",
          by: "Priya N.",
          what: "Bust for S changed",
          chart: chart([33, 35]),
        },
      ],
    });
    // Only the signed-in shop's history, and its chart read through its session.
    expect(m.listVersions).toHaveBeenCalledWith(SHOP, ID);
    expect(m.getChart).toHaveBeenCalledWith(admin, ID);
  });

  it("previews against nothing when the stored chart fails the checks", async () => {
    m.getChart.mockResolvedValue({
      id: ID,
      name: "Women's tops",
      fieldErrors: { name: "Too long" },
      raw: {},
    });
    expect(await load()).toMatchObject({ current: null });
  });

  it("answers 404 for a chart that isn't there", async () => {
    await expect(load("abc")).rejects.toMatchObject({ status: 404 });
    expect(m.listVersions).not.toHaveBeenCalled();
    m.getChart.mockRejectedValue(new ChartNotFoundError());
    await expect(load()).rejects.toMatchObject({ status: 404 });
  });

  it("shows its error state when Shopify or the database fails, and logs why", async () => {
    m.listVersions.mockRejectedValue(new Error("value 'secret' refused"));
    expect(await result(load())).toEqual({
      status: 502,
      body: { error: { code: "server", message: expect.any(String) } },
    });
    m.listVersions.mockResolvedValue([]);
    m.shopTimeZone.mockRejectedValue(new AdminApiError("failed", "HTTP 500"));
    expect(await result(load())).toEqual({
      status: 502,
      body: { error: { code: "shopify", message: expect.any(String) } },
    });
    // Shopify's raw text is logged; a database message, which can echo
    // values, is not.
    expect(logs.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ level: "error", shop: SHOP, detail: "Error" }),
      expect.objectContaining({
        level: "error",
        shop: SHOP,
        detail: "HTTP 500",
      }),
    ]);
  });

  it("passes the login redirect on when there's no session", async () => {
    m.authenticate.mockRejectedValue(new Response(null, { status: 302 }));
    await expect(load()).rejects.toMatchObject({ status: 302 });
    expect(m.listVersions).not.toHaveBeenCalled();
  });
});
