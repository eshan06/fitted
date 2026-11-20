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
  productCoverage: vi.fn(),
  getPlan: vi.fn(),
  pricingPlansUrl: vi.fn(),
  resolveIfStale: vi.fn(),
}));
vi.mock("../shopify.server", () => ({
  authenticate: { admin: m.authenticate },
}));
vi.mock("../models/chart.server", async (orig) => ({
  ...(await orig<typeof import("../models/chart.server")>()),
  chartPages: m.chartPages,
  countChartProducts: m.countChartProducts,
  productCoverage: m.productCoverage,
}));
vi.mock("../models/rules.server", () => ({
  resolveIfStale: m.resolveIfStale,
}));
vi.mock("../models/admin.server", async (orig) => ({
  ...(await orig<typeof import("../models/admin.server")>()),
  pricingPlansUrl: m.pricingPlansUrl,
}));
vi.mock("../models/billing.server", async (orig) => ({
  ...(await orig<typeof import("../models/billing.server")>()),
  getPlan: m.getPlan,
}));
const { default: Home, loader } = await import("./app._index");
type Data = Awaited<Awaited<ReturnType<typeof loader>>["home"]>;
type Ok = Extract<Data, { plan: unknown }>;

const SHOP = "fitted-dev.myshopify.com";
const admin = { graphql: vi.fn() };
const PLANS =
  "https://admin.shopify.com/store/fitted-dev/charges/fitted/pricing_plans";
const stored = (
  n: number,
  status: "ACTIVE" | "DRAFT",
  extra: Partial<StoredChart> & Record<string, unknown> = {},
): StoredChart =>
  ({
    id: `gid://shopify/Metaobject/${n}`,
    handle: `c-000000000${n}`,
    status,
    updatedAt: "2026-11-14T10:00:00Z",
    name: `Chart ${n}`,
    chart: { template: "tops", content: {} },
    ...extra,
  }) as StoredChart;
async function* pages(...p: StoredChart[][]) {
  yield* p;
}
const N = (count: number, atLeast = false) => ({ count, atLeast });
const load = async () =>
  loader({
    request: new Request("https://fitted.test/app"),
  } as LoaderFunctionArgs);

let logs: string[];
beforeEach(() => {
  vi.resetAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => logs.push(line));
  m.authenticate.mockResolvedValue({ admin, session: { shop: SHOP } });
  m.getPlan.mockResolvedValue({ plan: "standard", checkFailed: false });
  m.pricingPlansUrl.mockResolvedValue(PLANS);
  m.resolveIfStale.mockResolvedValue(undefined);
  m.productCoverage.mockResolvedValue({
    all: N(340),
    covered: N(312),
    missing: [{ id: "gid://shopify/Product/1", title: "Merino crew socks" }],
  });
  m.countChartProducts.mockImplementation(async (_a, ids: string[]) =>
    Object.fromEntries(
      ids.map((id) => [id, N(Number(id.split("/").pop()) * 10)]),
    ),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("loading Home", () => {
  it("reads the charts, counts, plan and coverage for the session's shop", async () => {
    m.chartPages.mockReturnValue(
      pages(
        [
          stored(1, "ACTIVE"),
          stored(2, "DRAFT", {
            name: "",
            chart: undefined,
            raw: { importNote: "Check units" },
            fieldErrors: { name: "Required" },
          }),
        ],
        [stored(3, "ACTIVE", { chart: { importNote: "" } as never })],
      ),
    );
    const { home, storeUrl } = await load();
    expect(storeUrl).toBe(`https://${SHOP}`);
    expect(await home).toEqual({
      plan: "standard",
      plansUrl: PLANS,
      charts: 3,
      active: 2,
      rows: [
        {
          id: "gid://shopify/Metaobject/3",
          name: "Chart 3",
          status: "ACTIVE",
          note: null,
          products: N(30),
        },
        expect.objectContaining({
          name: "Untitled chart",
          note: "Check units",
        }),
        expect.objectContaining({ name: "Chart 1" }),
      ],
      products: {
        all: N(340),
        covered: N(312),
        missing: ["Merino crew socks"],
      },
    });
    expect(m.authenticate).toHaveBeenCalledOnce();
    expect(m.getPlan).toHaveBeenCalledWith(SHOP);
    expect(m.pricingPlansUrl).toHaveBeenCalledWith(admin, SHOP);
    expect(m.productCoverage).toHaveBeenCalledWith(admin);
    expect(m.resolveIfStale).toHaveBeenCalledExactlyOnceWith(SHOP);
  });

  it("shows at most five charts, most products first", async () => {
    m.chartPages.mockReturnValue(
      pages([1, 2, 3, 4, 5, 6].map((n) => stored(n, "DRAFT"))),
    );
    const home = (await (await load()).home) as Ok;
    expect(home.rows.map((r) => r.name)).toEqual(
      [6, 5, 4, 3, 2].map((n) => `Chart ${n}`),
    );
  });

  it("answers a failed Shopify call with the error state and logs the detail", async () => {
    m.chartPages.mockReturnValue(pages([]));
    m.productCoverage.mockRejectedValue(
      new AdminApiError("Shopify request failed", "HTTP 503 raw text"),
    );
    const home = await (await load()).home;
    expect(home).toEqual({
      error: { code: "shopify", message: expect.any(String) },
    });
    expect(JSON.stringify(home)).not.toContain("raw text");
    expect(JSON.parse(logs[0])).toEqual({
      level: "error",
      msg: "Shopify request failed",
      shop: SHOP,
      route: "app._index",
      detail: "HTTP 503 raw text",
    });
  });

  it("passes the library's login redirect on and reads nothing", async () => {
    const login = new Response(null, { status: 302 });
    m.authenticate.mockRejectedValue(login);
    await expect(load()).rejects.toBe(login);
    expect(m.chartPages).not.toHaveBeenCalled();
    expect(m.resolveIfStale).not.toHaveBeenCalled();
  });
});

describe("the screen", () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const OK: Ok = {
    plan: "standard",
    plansUrl: PLANS,
    charts: 4,
    active: 3,
    rows: [
      {
        id: "gid://shopify/Metaobject/1",
        name: "Women's tops",
        status: "ACTIVE",
        note: null,
        products: N(148),
      },
      {
        id: "gid://shopify/Metaobject/4",
        name: "Shoes (US, UK, EU)",
        status: "DRAFT",
        note: "Check units",
        products: N(27),
      },
    ],
    products: {
      all: N(340),
      covered: N(312),
      missing: ["Merino crew socks", "Canvas tote bag"],
    },
  };
  const show = async (...homes: Promise<Data>[]) => {
    let calls = 0;
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: Home,
        loader: () => ({
          storeUrl: `https://${SHOP}`,
          home: homes[Math.min(calls++, homes.length - 1)],
        }),
      },
    ]);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    await act(async () => createRoot(el).render(<Stub />));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    return el;
  };
  const text = (el: Element) => el.textContent?.replace(/\s+/g, " ") ?? "";
  const banner = (el: Element) =>
    el.querySelector("s-banner")?.getAttribute("heading");
  const button = (el: Element, label: string) =>
    [...el.querySelectorAll("s-button")].find(
      (b) => b.textContent === label,
    ) as HTMLElement | undefined;

  it("shows the returning merchant's plan, charts and products without a chart", async () => {
    const el = await show(Promise.resolve(OK));
    const t = text(el);
    expect(banner(el)).toBe(
      "Standard plan, $9 a month. No order fees, however many orders your store gets.",
    );
    expect(
      el.querySelector(`s-link[href="${PLANS}"]`)?.getAttribute("target"),
    ).toBe("_top");
    expect(t).toContain("Women's tops148Published");
    expect(t).toContain("Shoes (US, UK, EU)27Check units");
    expect(el.querySelector('s-link[href="/app/charts/4"]')?.textContent).toBe(
      "Check units",
    );
    expect(el.querySelector('s-link[href="/app/charts"]')?.textContent).toBe(
      "Manage",
    );
    expect(
      el.querySelector('s-section[heading="28 products have no size guide"]'),
    ).not.toBeNull();
    expect(t).toContain("Shoppers on these pages can't check sizing.");
    expect(t).toContain("Merino crew socksCanvas tote bag");
    expect(button(el, "Add a display rule")?.getAttribute("href")).toBe(
      "/app/rules",
    );
    expect(button(el, "View on store")?.getAttribute("href")).toBe(
      `https://${SHOP}`,
    );
    expect(button(el, "View on store")?.getAttribute("target")).toBe("_blank");
    expect(button(el, "Create chart")?.getAttribute("href")).toBe(
      "/app/charts/new",
    );
  });

  it("shows a draft without a note as Draft, and one product in the singular", async () => {
    const el = await show(
      Promise.resolve({
        ...OK,
        rows: [{ ...OK.rows[1], note: null }],
        products: { all: N(340), covered: N(339), missing: ["Socks"] },
      }),
    );
    expect(text(el)).toContain("Shoes (US, UK, EU)27Draft");
    expect(
      el.querySelector('s-section[heading="1 product has no size guide"]'),
    ).not.toBeNull();
  });

  it("counts products without a chart as a floor past Shopify's 10,000 cap", async () => {
    const el = await show(
      Promise.resolve({
        ...OK,
        products: {
          all: N(10000, true),
          covered: N(10000, true),
          missing: ["Socks", "Tote", "Hat"],
        },
      }),
    );
    expect(
      el.querySelector('s-section[heading="3+ products have no size guide"]'),
    ).not.toBeNull();
  });

  it("shows the Free plan's banner on a first install, with no charts table", async () => {
    const el = await show(
      Promise.resolve({
        ...OK,
        plan: "free",
        charts: 0,
        active: 0,
        rows: [],
        products: { all: N(340), covered: N(0), missing: [] },
      }),
    );
    expect(banner(el)).toBe(
      "Free plan: 3 charts, CSV export, no watermark. No order fees on any plan.",
    );
    expect(text(el)).not.toContain("Your charts");
  });

  it("shows Free at its limit", async () => {
    const el = await show(Promise.resolve({ ...OK, plan: "free" }));
    expect(banner(el)).toBe("Free plan: 3 of 3 published charts");
    expect(text(el)).toContain(
      "Drafts don't count. To publish a 4th, set one to Draft or move to Standard, $9 a month.",
    );
  });

  it("shows Pro, and every product covered", async () => {
    const el = await show(
      Promise.resolve({
        ...OK,
        plan: "pro",
        products: { all: N(340), covered: N(340), missing: [] },
      }),
    );
    expect(banner(el)).toBe("Pro plan, $15 a month. No order fees.");
    expect(
      el.querySelector('s-section[heading="Every product has a size guide"]'),
    ).not.toBeNull();
    expect(text(el)).toContain(
      "All 340 products show a chart. New products get one when they match a display rule.",
    );
    expect(button(el, "Review display rules")?.getAttribute("href")).toBe(
      "/app/rules",
    );
  });

  it("shows the loading state, then the error with Try again that reloads", async () => {
    let fail!: (d: Data) => void;
    const el = await show(
      new Promise<Data>((r) => (fail = r)),
      Promise.resolve(OK),
    );
    expect(
      el.querySelector('[accessibilityLabel="Loading your size guides"]'),
    ).not.toBeNull();
    await act(async () => fail({ error: { code: "shopify", message: "x" } }));
    expect(
      el.querySelector(
        's-banner[heading="Your charts and numbers didn\'t load"]',
      ),
    ).not.toBeNull();
    expect(text(el)).toContain(
      "Still not working? Email [SUPPORT EMAIL] and we'll look into it.",
    );
    await act(async () => button(el, "Try again")?.click());
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(text(el)).toContain("Women's tops");
  });
});
