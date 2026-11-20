// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiError } from "../models/admin.server";
import { ChartNotFoundError, type StoredChart } from "../models/chart.server";

const m = vi.hoisted(() => ({
  authenticate: vi.fn(),
  chartPages: vi.fn(),
  countChartProducts: vi.fn(),
  getPlan: vi.fn(),
  pricingPlansUrl: vi.fn(),
  canReadProducts: vi.fn(),
  deleteChart: vi.fn(),
  startResolve: vi.fn(),
}));
vi.mock("../shopify.server", () => ({
  authenticate: { admin: m.authenticate },
}));
vi.mock("../models/chart.server", async (orig) => ({
  ...(await orig<typeof import("../models/chart.server")>()),
  chartPages: m.chartPages,
  countChartProducts: m.countChartProducts,
  deleteChart: m.deleteChart,
}));
vi.mock("../models/rules.server", () => ({ startResolve: m.startResolve }));
vi.mock("../models/admin.server", async (orig) => ({
  ...(await orig<typeof import("../models/admin.server")>()),
  pricingPlansUrl: m.pricingPlansUrl,
  canReadProducts: m.canReadProducts,
}));
vi.mock("../models/billing.server", async (orig) => ({
  ...(await orig<typeof import("../models/billing.server")>()),
  getPlan: m.getPlan,
}));
const {
  default: SizeCharts,
  action,
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
  m.canReadProducts.mockResolvedValue(true);
  m.deleteChart.mockResolvedValue(undefined);
  m.startResolve.mockResolvedValue(undefined);
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
        [{ ...stored(2, "DRAFT", "2026-11-17T10:00:00Z", false), name: "" }],
      ),
    );
    expect(await load()).toEqual({
      rows: [
        {
          id: "gid://shopify/Metaobject/2",
          name: "Untitled chart",
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

const CHART = "gid://shopify/Metaobject/1";
const del = async (id?: string) => {
  const body = new FormData();
  if (id !== undefined) body.set("id", id);
  const res = await action({
    request: new Request("https://fitted.test/app/charts?index", {
      method: "POST",
      body,
    }),
  } as ActionFunctionArgs);
  return res instanceof Response
    ? res
    : "data" in (res as object)
      ? (res as { data: unknown; init: { status: number } })
      : { data: res, init: { status: 200 } };
};

describe("deleting a chart", () => {
  it("deletes it, then resolves every product as the merchant's", async () => {
    expect(await del(CHART)).toMatchObject({
      data: { ok: true },
      init: { status: 200 },
    });
    expect(m.canReadProducts).toHaveBeenCalledWith(admin);
    expect(m.deleteChart).toHaveBeenCalledExactlyOnceWith(admin, CHART);
    expect(m.canReadProducts.mock.invocationCallOrder[0]).toBeLessThan(
      m.deleteChart.mock.invocationCallOrder[0],
    );
    expect(m.startResolve).toHaveBeenCalledExactlyOnceWith(SHOP, true);
    expect(m.deleteChart.mock.invocationCallOrder[0]).toBeLessThan(
      m.startResolve.mock.invocationCallOrder[0],
    );
  });

  it("counts a chart that's already gone as deleted, so a repeat is done", async () => {
    m.deleteChart.mockRejectedValue(new ChartNotFoundError());
    expect(await del(CHART)).toMatchObject({ data: { ok: true } });
    expect(m.startResolve).toHaveBeenCalledExactlyOnceWith(SHOP, true);
  });

  it.each([
    ["no id", undefined],
    ["an empty id", ""],
    ["a product id", "gid://shopify/Product/1"],
    ["a numeric id", "1"],
  ])("refuses %s with 422 and touches nothing", async (_, id) => {
    expect(await del(id)).toMatchObject({
      data: {
        fieldErrors: { id: expect.stringContaining("nothing was deleted") },
      },
      init: { status: 422 },
    });
    expect(m.canReadProducts).not.toHaveBeenCalled();
    expect(m.deleteChart).not.toHaveBeenCalled();
    expect(m.startResolve).not.toHaveBeenCalled();
  });

  it("refuses staff without Products access before deleting", async () => {
    m.canReadProducts.mockResolvedValue(false);
    expect(await del(CHART)).toMatchObject({
      data: {
        error: {
          code: "product_access",
          message: expect.stringContaining("Nothing was deleted."),
        },
      },
      init: { status: 403 },
    });
    expect(m.deleteChart).not.toHaveBeenCalled();
    expect(m.startResolve).not.toHaveBeenCalled();
  });

  it.each([
    ["the access check", () => m.canReadProducts],
    ["the delete", () => m.deleteChart],
  ])(
    "answers 502 when %s fails, logs the detail and resolves nothing",
    async (_, failing) => {
      failing().mockRejectedValue(
        new AdminApiError("Shopify request failed", "HTTP 503 raw text"),
      );
      const res = await del(CHART);
      expect(res).toMatchObject({
        data: { error: { code: "shopify" } },
        init: { status: 502 },
      });
      expect(JSON.stringify(res)).not.toContain("raw text");
      expect(JSON.parse(logs[0])).toEqual({
        level: "error",
        msg: "Shopify request failed",
        shop: SHOP,
        route: "app.charts._index",
        detail: "HTTP 503 raw text",
      });
      expect(m.startResolve).not.toHaveBeenCalled();
    },
  );

  it("passes the library's login redirect on and deletes nothing", async () => {
    const login = new Response(null, { status: 302 });
    m.authenticate.mockRejectedValue(login);
    await expect(del(CHART)).rejects.toBe(login);
    expect(m.deleteChart).not.toHaveBeenCalled();
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
  // Each load streams the next list; the last one repeats. `answers` are the
  // delete action's, in turn; `posted` collects the ids it was sent.
  let answers: unknown[] = [];
  let posted: unknown[] = [];
  const show = async (...lists: Promise<List>[]) => {
    let calls = 0;
    posted = [];
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: SizeCharts,
        loader: () => ({ list: lists[Math.min(calls++, lists.length - 1)] }),
        action: async ({ request }) => {
          posted.push((await request.formData()).get("id"));
          return answers.shift();
        },
      },
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
      input.dispatchEvent(new Event("input")); // Polaris fields don't bubble it
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

  const button = (el: Element, label: string) =>
    [...el.querySelectorAll("s-button")].find(
      (b) => b.textContent === label,
    ) as HTMLElement;

  it.each([
    [
      "Shopify failed",
      () => Promise.resolve({ error: { code: "shopify", message: "x" } }),
    ],
    ["the stream failed", () => Promise.reject(new Error("boom"))],
  ])(
    "shows the error state when %s, and Try again reloads",
    async (_, failed) => {
      const first = failed() as Promise<List>;
      first.catch(() => {}); // Await sees the rejection; this only marks it handled
      const el = await show(
        first,
        Promise.resolve({ rows: ROWS, limit: null }),
      );
      expect(el.querySelector("s-banner")?.getAttribute("heading")).toBe(
        "We couldn't load your size charts",
      );
      expect(el.querySelector("s-button[loading]")).toBeNull();
      await act(async () => button(el, "Try again").click());
      await act(() => new Promise((r) => setTimeout(r, 10)));
      expect(el.querySelector("s-banner")).toBeNull();
      expect(el.querySelectorAll("s-table-row")).toHaveLength(3);
    },
  );

  it("names the status when only the status filter matches nothing", async () => {
    const el = await show(Promise.resolve({ rows: [ROWS[0]], limit: null }));
    await type(el, "s-select", "DRAFT");
    expect(el.textContent).toContain("No charts match “Draft”");
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
    await act(async () => button(el, "Clear search").click());
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

  describe("delete", () => {
    const one = (n: number) => [
      ...ROWS,
      { ...row(4, "Belts", "DRAFT"), products: { count: n, atLeast: false } },
    ];
    const open = async (el: Element, name: string) => {
      const menu = el.querySelector(
        `s-menu[accessibilityLabel="Actions for ${name}"]`,
      ) as HTMLElement;
      const trigger = el.querySelector(
        `s-button[accessibilityLabel="Actions for ${name}"]`,
      );
      expect(trigger?.getAttribute("commandFor")).toBe(menu.id);
      const item = menu.querySelector("s-button") as HTMLElement;
      expect(item.getAttribute("commandFor")).toBe("delete-chart");
      expect(item.getAttribute("command")).toBe("--show");
      await act(async () => item.click());
      return el.querySelector("s-modal#delete-chart") as HTMLElement;
    };

    it.each([
      [
        "Women's tops",
        0,
        "It shows on 10 products. They'll show the next chart that matches them, or no size guide.",
      ],
      [
        "Shoes",
        0,
        "It shows on 30+ products. They'll show the next chart that matches them, or no size guide.",
      ],
      [
        "Belts",
        1,
        "It shows on 1 product. They'll show the next chart that matches them, or no size guide.",
      ],
      ["Belts", 0, "No products show it."],
    ])("names %s and how many products show it", async (name, n, copy) => {
      const el = await show(Promise.resolve({ rows: one(n), limit: null }));
      const modal = await open(el, name);
      expect(modal.getAttribute("heading")).toBe(`Delete ${name}?`);
      expect(modal.textContent).toContain(copy);
      expect(modal.querySelector("s-banner")).toBeNull();
      const cancel = button(modal, "Cancel");
      expect(cancel.getAttribute("command")).toBe("--hide");
      expect(cancel.getAttribute("commandFor")).toBe("delete-chart");
    });

    it("deletes the chart and reloads the list without it", async () => {
      answers = [{ ok: true }];
      const el = await show(
        Promise.resolve({ rows: ROWS, limit: null }),
        Promise.resolve({ rows: ROWS.slice(1), limit: null }),
      );
      const modal = await open(el, "Women's tops");
      const hide = vi.fn();
      Object.assign(modal, { hideOverlay: hide });
      await act(async () => button(modal, "Delete").click());
      await act(() => new Promise((r) => setTimeout(r, 10)));
      expect(posted).toEqual(["gid://shopify/Metaobject/1"]);
      expect(hide).toHaveBeenCalledOnce();
      expect(el.querySelectorAll("s-table-row")).toHaveLength(2);
      expect(el.textContent).not.toContain("Women's tops");
    });

    it("keeps the confirmation open with the reason and Try again", async () => {
      answers = [
        { error: { code: "shopify", message: "Fitted didn't get an answer." } },
        { ok: true },
      ];
      const el = await show(Promise.resolve({ rows: ROWS, limit: null }));
      const modal = await open(el, "Women's tops");
      const hide = vi.fn();
      Object.assign(modal, { hideOverlay: hide });
      await act(async () => button(modal, "Delete").click());
      await act(() => new Promise((r) => setTimeout(r, 10)));
      const banner = modal.querySelector("s-banner");
      expect(banner?.getAttribute("tone")).toBe("critical");
      expect(banner?.getAttribute("heading")).toBe(
        "We couldn't delete this chart",
      );
      expect(banner?.textContent).toBe("Fitted didn't get an answer.");
      expect(hide).not.toHaveBeenCalled();

      await act(async () => button(modal, "Try again").click());
      await act(() => new Promise((r) => setTimeout(r, 10)));
      expect(posted).toHaveLength(2);
      expect(hide).toHaveBeenCalledOnce();
    });

    it("shows a refused id's message from the action", async () => {
      answers = [{ fieldErrors: { id: "Reload the page and try again." } }];
      const el = await show(Promise.resolve({ rows: ROWS, limit: null }));
      const modal = await open(el, "Kids' outerwear");
      await act(async () => button(modal, "Delete").click());
      await act(() => new Promise((r) => setTimeout(r, 10)));
      expect(modal.querySelector("s-banner")?.textContent).toBe(
        "Reload the page and try again.",
      );
    });
  });
});
