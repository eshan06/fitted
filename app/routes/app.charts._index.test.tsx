// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiError } from "../models/admin.server";
import type { StoredChart } from "../models/chart.server";

const m = vi.hoisted(() => ({
  authenticate: vi.fn(),
  chartPages: vi.fn(),
  countChartProducts: vi.fn(),
  getPlan: vi.fn(),
  pricingPlansUrl: vi.fn(),
}));
vi.mock("../shopify.server", () => ({
  authenticate: { admin: m.authenticate },
}));
vi.mock("../models/chart.server", async (orig) => ({
  ...(await orig<typeof import("../models/chart.server")>()),
  chartPages: m.chartPages,
  countChartProducts: m.countChartProducts,
}));
vi.mock("../models/admin.server", async (orig) => ({
  ...(await orig<typeof import("../models/admin.server")>()),
  pricingPlansUrl: m.pricingPlansUrl,
}));
vi.mock("../models/billing.server", async (orig) => ({
  ...(await orig<typeof import("../models/billing.server")>()),
  getPlan: m.getPlan,
}));
const {
  default: SizeCharts,
  loader,
  filterRows,
} = await import("./app.charts._index");
type List = Awaited<Awaited<ReturnType<typeof loader>>["list"]>;
type Row = Extract<List, { rows: unknown }>["rows"][number];

const SHOP = "fitted-dev.myshopify.com";
const admin = { graphql: vi.fn() };
const PLANS =
  "https://admin.shopify.com/store/fitted-dev/charges/fitted/pricing_plans";
const stored = (
  n: number,
  status: "ACTIVE" | "DRAFT",
  updatedAt: string,
  valid = true,
): StoredChart =>
  ({
    id: `gid://shopify/Metaobject/${n}`,
    handle: `c-000000000${n}`,
    status,
    updatedAt,
    name: `Chart ${n}`,
    ...(valid
      ? { chart: { template: n === 1 ? "tops" : "bras_swimwear" } }
      : { fieldErrors: { template: "Pick a template" } }),
  }) as StoredChart;
async function* pages(...p: StoredChart[][]) {
  yield* p;
}
const load = async () =>
  (
    await loader({
      request: new Request("https://fitted.test/app/charts"),
    } as LoaderFunctionArgs)
  ).list;

let logs: string[];
beforeEach(() => {
  vi.resetAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => logs.push(line));
  m.authenticate.mockResolvedValue({ admin, session: { shop: SHOP } });
  m.getPlan.mockResolvedValue({ plan: "free", checkFailed: false });
  m.pricingPlansUrl.mockResolvedValue(PLANS);
  m.countChartProducts.mockImplementation(async (_a, ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { count: 7, atLeast: false }])),
  );
});
afterEach(() => vi.restoreAllMocks());

describe("loading the list", () => {
  it("lists every chart newest first with its template and product count", async () => {
    m.chartPages.mockReturnValue(
      pages(
        [stored(1, "ACTIVE", "2026-11-14T10:00:00Z")],
        [stored(2, "DRAFT", "2026-11-17T10:00:00Z", false)],
      ),
    );
    expect(await load()).toEqual({
      rows: [
        {
          id: "gid://shopify/Metaobject/2",
          name: "Chart 2",
          template: null,
          status: "DRAFT",
          products: { count: 7, atLeast: false },
          updatedAt: "2026-11-17T10:00:00Z",
        },
        expect.objectContaining({ name: "Chart 1", template: "tops" }),
      ],
      limit: null,
    });
    expect(m.authenticate).toHaveBeenCalledOnce();
    expect(m.countChartProducts).toHaveBeenCalledWith(admin, [
      "gid://shopify/Metaobject/1",
      "gid://shopify/Metaobject/2",
    ]);
    expect(m.getPlan).toHaveBeenCalledWith(SHOP);
    expect(m.pricingPlansUrl).not.toHaveBeenCalled();
  });

  it("flags Free at 3 Active charts with the plan page, and no other plan", async () => {
    const three = () =>
      pages([1, 2, 3, 4].map((n) => stored(n, n < 4 ? "ACTIVE" : "DRAFT", "")));
    m.chartPages.mockReturnValue(three());
    expect(await load()).toMatchObject({
      limit: { active: 3, plansUrl: PLANS },
    });
    expect(m.pricingPlansUrl).toHaveBeenCalledWith(admin, SHOP);

    m.chartPages.mockReturnValue(three());
    m.getPlan.mockResolvedValue({ plan: "standard", checkFailed: false });
    expect(await load()).toMatchObject({ limit: null });
  });

  it("answers a failed Shopify call with the error state and logs the detail", async () => {
    m.chartPages.mockReturnValue(
      (async function* () {
        yield [];
        throw new AdminApiError("Shopify request failed", "HTTP 503 raw text");
      })(),
    );
    const list = await load();
    expect(list).toEqual({
      error: { code: "shopify", message: expect.any(String) },
    });
    expect(JSON.stringify(list)).not.toContain("raw text");
    expect(JSON.parse(logs[0])).toEqual({
      level: "error",
      msg: "Shopify request failed",
      shop: SHOP,
      route: "app.charts._index",
      detail: "HTTP 503 raw text",
    });
  });

  it("passes the library's login redirect on and reads nothing", async () => {
    const login = new Response(null, { status: 302 });
    m.authenticate.mockRejectedValue(login);
    await expect(load()).rejects.toBe(login);
    expect(m.chartPages).not.toHaveBeenCalled();
  });
});

const row = (n: number, name: string, status: Row["status"]): Row => ({
  id: `gid://shopify/Metaobject/${n}`,
  name,
  template: "tops",
  status,
  products: { count: n * 10, atLeast: n === 3 },
  updatedAt: "2026-11-14T10:00:00Z",
});
const ROWS = [
  row(1, "Women's tops", "ACTIVE"),
  row(2, "Kids' outerwear", "DRAFT"),
  { ...row(3, "Shoes", "ACTIVE"), template: null },
];

it("filters by name, ignoring case and spaces, and by status", () => {
  expect(filterRows(ROWS, " TOPS ", "all").map((r) => r.name)).toEqual([
    "Women's tops",
  ]);
  expect(filterRows(ROWS, "", "DRAFT").map((r) => r.name)).toEqual([
    "Kids' outerwear",
  ]);
  expect(filterRows(ROWS, "s", "ACTIVE")).toHaveLength(2);
});

describe("the screen", () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const show = async (list: Promise<List>) => {
    const Stub = createRoutesStub([
      { path: "/", Component: SizeCharts, loader: () => ({ list }) },
    ]);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    await act(async () => createRoot(el).render(<Stub />));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    return el;
  };
  const type = async (el: Element, selector: string, value: string) => {
    const input = el.querySelector(selector) as HTMLElement & { value: string };
    input.value = value;
    await act(async () => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("shows the table while the charts load", async () => {
    const el = await show(new Promise(() => {}));
    expect(el.querySelector("s-table")?.hasAttribute("loading")).toBe(true);
    expect(el.textContent).toContain(
      "Saved in your store. Shoppers see the Active ones.",
    );
  });

  it("shows the empty state on a first visit", async () => {
    const el = await show(Promise.resolve({ rows: [], limit: null }));
    expect(el.textContent).toContain("No size charts yet");
    expect(el.textContent).toContain("Measure twice, publish once.");
    expect(el.querySelector("s-table")).toBeNull();
  });

  it("shows the error state with Try again", async () => {
    const el = await show(
      Promise.resolve({ error: { code: "shopify", message: "x" } }),
    );
    expect(el.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "We couldn't load your size charts",
    );
    expect(el.textContent).toContain("Try again");
    expect(el.querySelector("s-button[loading]")).toBeNull();
  });

  it("lists the charts, searches them and clears the search", async () => {
    const el = await show(Promise.resolve({ rows: ROWS, limit: null }));
    const text = () => el.textContent ?? "";
    expect(el.querySelectorAll("s-table-row")).toHaveLength(3);
    expect(text()).toContain("Women's topsTops");
    expect(text()).toContain("This chart has errors. Open it to fix them.");
    expect(text()).toContain("30+");
    expect(text()).toContain("Nov 14, 2026");
    expect(text()).toContain("3 charts");
    expect(el.querySelector("s-link")?.getAttribute("href")).toBe(
      "/app/charts/1",
    );
    expect(el.querySelector("s-banner")).toBeNull();

    await type(el, "s-search-field", "kids");
    expect(el.querySelectorAll("s-table-row")).toHaveLength(1);
    expect(text()).toContain("1 of 3 charts");

    await type(el, "s-search-field", "linen");
    expect(text()).toContain("No charts match “linen”");
    const clear = [...el.querySelectorAll("s-button")].find(
      (b) => b.textContent === "Clear search",
    ) as HTMLElement;
    await act(async () => clear.click());
    expect(el.querySelectorAll("s-table-row")).toHaveLength(3);

    await type(el, "s-select", "DRAFT");
    expect(el.querySelectorAll("s-table-row")).toHaveLength(1);
  });

  it("shows Free's limit with a link to change plan", async () => {
    const el = await show(
      Promise.resolve({ rows: ROWS, limit: { active: 3, plansUrl: PLANS } }),
    );
    const banner = el.querySelector("s-banner");
    expect(banner?.getAttribute("heading")).toBe(
      "Free plan: 3 of 3 Active charts",
    );
    expect(banner?.textContent).toContain(
      "Drafts don't count. To make a 4th Active, set one to Draft or move to Standard, $9 a month.",
    );
    const link = banner?.querySelector("s-link");
    expect(link?.getAttribute("href")).toBe(PLANS);
    expect(link?.getAttribute("target")).toBe("_top");
  });
});
