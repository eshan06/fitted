// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError, AdminApiError } from "../models/admin.server";
import type { StoredChart } from "../models/chart.server";

const m = vi.hoisted(() => ({
  authenticate: vi.fn(),
  chartPages: vi.fn(),
  countChartProducts: vi.fn(),
  productCoverage: vi.fn(),
  getPlan: vi.fn(),
  lastConfirmedPlan: vi.fn(),
  pricingPlansUrl: vi.fn(),
  resolveIfStale: vi.fn(),
  extensions: vi.fn(),
  findUnique: vi.fn(),
}));
vi.mock("../shopify.server", () => ({
  authenticate: { admin: m.authenticate },
}));
vi.mock("../db.server", () => ({
  default: { shop: { findUnique: m.findUnique } },
}));
vi.mock("@shopify/shopify-app-react-router/react", () => ({
  AppProvider: ({ children }: { children: ReactNode }) => children,
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
  lastConfirmedPlan: m.lastConfirmedPlan,
}));
const bridge = { app: { extensions: m.extensions } };
vi.mock("@shopify/app-bridge-react", () => ({ useAppBridge: () => bridge }));
const { default: Home, loader } = await import("./app._index");
const shell = await import("./app");
const followUp = await import("./app.plan-check");
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
  vi.stubEnv("SHOPIFY_API_KEY", "key123");
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => logs.push(line));
  m.authenticate.mockResolvedValue({ admin, session: { shop: SHOP } });
  m.getPlan.mockResolvedValue({
    plan: "standard",
    yearly: false,
    checkFailed: false,
  });
  m.lastConfirmedPlan.mockResolvedValue({
    plan: "standard",
    yearly: false,
    at: null,
  });
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
  m.extensions.mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const THEME_ON = [
  {
    handle: "size-guide",
    type: "theme_app_extension",
    activations: [{ handle: "size-guide", status: "active" }],
  },
];

// The plan Home loads with: the last one a check confirmed (#193).
const lastConfirmed = (plan: string, yearly: boolean | null = false) =>
  m.lastConfirmedPlan.mockResolvedValue({ plan, yearly, at: null });

describe("loading Home", () => {
  it("reads the charts, counts, last confirmed plan and coverage for the session's shop", async () => {
    m.chartPages.mockReturnValue(
      pages(
        [
          stored(1, "ACTIVE", { handle: "i-7-0" }),
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
    const { home, storeUrl, planAtLoad } = await load();
    expect(storeUrl).toBe(`https://${SHOP}`);
    // For the shell, which reloads Home if the plan check settles on another.
    expect(planAtLoad).toEqual({ plan: "standard", yearly: false, at: null });
    expect(await home).toEqual({
      plan: "standard",
      yearly: false,
      plansUrl: PLANS,
      themeUrl:
        "https://admin.shopify.com/store/fitted-dev/themes/current/editor?template=product&addAppBlockId=key123/size-guide&target=mainSection",
      charts: 3,
      active: 2,
      limit: null,
      imported: 1,
      fitLive: false,
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
    // Never the check itself, which the shell streams and settles.
    expect(m.lastConfirmedPlan).toHaveBeenCalledExactlyOnceWith(SHOP);
    expect(m.getPlan).not.toHaveBeenCalled();
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

  it("gives Free its limit of 3 published charts, and no other plan", async () => {
    const three = () =>
      pages([1, 2, 3, 4].map((n) => stored(n, n < 4 ? "ACTIVE" : "DRAFT")));
    lastConfirmed("free");
    m.chartPages.mockReturnValue(three());
    expect(await (await load()).home).toMatchObject({ active: 3, limit: 3 });

    m.chartPages.mockReturnValue(pages([stored(1, "ACTIVE")]));
    expect(await (await load()).home).toMatchObject({ active: 1, limit: 3 });

    lastConfirmed("standard");
    m.chartPages.mockReturnValue(three());
    expect(await (await load()).home).toMatchObject({ limit: null });
  });

  it("flags Free past its limit after a downgrade, with every chart still live", async () => {
    lastConfirmed("free");
    m.chartPages.mockReturnValue(
      pages([1, 2, 3, 4, 5].map((n) => stored(n, "ACTIVE"))),
    );
    expect(await (await load()).home).toMatchObject({ active: 5, limit: 3 });
  });

  it("passes on whether the plan is billed yearly, as the last check read it", async () => {
    m.chartPages.mockReturnValue(pages([stored(1, "ACTIVE")]));
    for (const yearly of [true, false, null]) {
      lastConfirmed("pro", yearly);
      expect(await (await load()).home).toMatchObject({ plan: "pro", yearly });
    }
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

  it("answers a read Shopify refuses the staff member with the no-access state, logging why (§15)", async () => {
    m.chartPages.mockReturnValue(pages([]));
    m.productCoverage.mockRejectedValue(
      new AccessDeniedError("Access denied for productsCount field."),
    );
    const home = await (await load()).home;
    expect(home).toEqual({
      error: {
        code: "access",
        message: expect.stringContaining("You need Products access"),
      },
    });
    expect(JSON.parse(logs[0])).toMatchObject({
      level: "error",
      shop: SHOP,
      route: "app._index",
      detail: "Access denied for productsCount field.",
    });
  });

  it("signs in again and loads Home when Shopify revoked the staff member's token (§3)", async () => {
    const fresh = { graphql: vi.fn() };
    m.authenticate
      .mockResolvedValueOnce({ admin, session: { shop: SHOP } })
      .mockResolvedValueOnce({ admin: fresh, session: { shop: SHOP } });
    m.chartPages.mockImplementation((a: unknown) =>
      a === admin
        ? (async function* () {
            yield [];
            // The library's bounce once it cleared the revoked token.
            throw new Response(null, { status: 302 });
          })()
        : pages([stored(1, "ACTIVE")]),
    );
    expect(await (await load()).home).toMatchObject({ charts: 1 });
    expect(m.authenticate).toHaveBeenCalledTimes(2);
    expect(m.productCoverage).toHaveBeenCalledWith(fresh);
  });

  it("passes the library's login redirect on and reads nothing", async () => {
    const login = new Response(null, { status: 302 });
    m.authenticate.mockRejectedValue(login);
    await expect(load()).rejects.toBe(login);
    expect(m.chartPages).not.toHaveBeenCalled();
    expect(m.resolveIfStale).not.toHaveBeenCalled();
  });

  it("finds a live fit finder only on Pro with a published chart that has one", async () => {
    const fit = { chart: { content: { fit: {} } } as never };
    const charts = () =>
      pages([stored(1, "ACTIVE", fit), stored(2, "DRAFT", fit)]);
    m.chartPages.mockReturnValue(charts());
    expect(await (await load()).home).toMatchObject({ fitLive: false });

    lastConfirmed("pro");
    m.chartPages.mockReturnValue(charts());
    expect(await (await load()).home).toMatchObject({ fitLive: true });

    m.chartPages.mockReturnValue(pages([stored(2, "DRAFT", fit)]));
    expect(await (await load()).home).toMatchObject({ fitLive: false });
  });
});

describe("the screen", () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const OK: Ok = {
    plan: "standard",
    yearly: false,
    plansUrl: PLANS,
    themeUrl: "https://admin.shopify.com/theme",
    charts: 4,
    active: 3,
    limit: null,
    imported: 12,
    fitLive: false,
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
      el.querySelector(
        's-section[accessibilityLabel="28 products have no size guide"]',
      ),
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
      el.querySelector(
        's-section[accessibilityLabel="1 product has no size guide"]',
      ),
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
      el.querySelector(
        's-section[accessibilityLabel="3+ products have no size guide"]',
      ),
    ).not.toBeNull();
  });

  it("shows the Free plan's banner on a first install, with no charts table", async () => {
    const el = await show(
      Promise.resolve({
        ...OK,
        plan: "free",
        yearly: null, // as on every shop whose plan check hasn't succeeded
        charts: 0,
        active: 0,
        limit: 3,
        rows: [],
        products: { all: N(340), covered: N(0), missing: [] },
      }),
    );
    expect(banner(el)).toBe(
      "Free plan: 3 charts, CSV export, no watermark. No order fees on any plan.",
    );
    expect(text(el)).not.toContain("Your charts");
  });

  it("shows a returning Free shop how many of its 3 charts are published", async () => {
    for (const active of [2, 0]) {
      const el = await show(
        Promise.resolve({ ...OK, plan: "free", active, limit: 3 }),
      );
      const plan = el.querySelector("s-banner")!;
      expect(plan.getAttribute("heading")).toBe(
        `Free plan: ${active} of 3 published charts`,
      );
      expect(plan.getAttribute("tone")).toBe("info");
      expect(text(plan)).toBe(
        "Drafts don't count. For more than 3, move to Standard, $9 a month.Change plan",
      );
      expect(
        plan.querySelector(`s-link[href="${PLANS}"]`)?.getAttribute("target"),
      ).toBe("_top");
    }
  });

  it("shows Free at its limit", async () => {
    const el = await show(Promise.resolve({ ...OK, plan: "free", limit: 3 }));
    expect(banner(el)).toBe("Free plan: 3 of 3 published charts");
    expect(text(el)).toContain(
      "Drafts don't count. To publish a 4th, set one to Draft or move to Standard, $9 a month.",
    );
  });

  it("shows Free over its limit after a downgrade, and how many to set to Draft", async () => {
    for (const [active, heading, fix] of [
      [
        5,
        "5 published charts, over Free's limit of 3",
        "They stay live. To publish another, set 3 to Draft or move to Standard, $9 a month.",
      ],
      [
        4,
        "4 published charts, over Free's limit of 3",
        "They stay live. To publish another, set 2 to Draft or move to Standard, $9 a month.",
      ],
    ] as const) {
      const el = await show(
        Promise.resolve({ ...OK, plan: "free", active, limit: 3 }),
      );
      const plan = el.querySelector("s-banner")!;
      expect(plan.getAttribute("heading")).toBe(heading);
      expect(plan.getAttribute("tone")).toBe("warning");
      expect(text(plan)).toBe(`${fix}Change plan`);
      expect(
        plan.querySelector(`s-link[href="${PLANS}"]`)?.getAttribute("target"),
      ).toBe("_top");
      expect(
        [...el.querySelectorAll("s-banner")].map((b) =>
          b.getAttribute("heading"),
        ),
      ).toEqual([heading]);
    }
  });

  it("prices a yearly payer's plan by the year", async () => {
    for (const [plan, heading] of [
      [
        "standard",
        "Standard plan, $90 a year. No order fees, however many orders your store gets.",
      ],
      ["pro", "Pro plan, $150 a year. No order fees."],
    ] as const) {
      const el = await show(Promise.resolve({ ...OK, plan, yearly: true }));
      expect(banner(el)).toBe(heading);
      expect(
        el.querySelector(`s-banner s-link[href="${PLANS}"]`)?.textContent,
      ).toBe("Change plan");
    }
  });

  it("states no price for a paid plan whose billing Fitted hasn't read", async () => {
    for (const plan of ["standard", "pro"] as const) {
      const el = await show(Promise.resolve({ ...OK, plan, yearly: null }));
      expect(el.querySelector("s-banner")).toBeNull();
      expect(text(el)).toContain("Women's tops");
    }
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
      el.querySelector(
        's-section[accessibilityLabel="Every product has a size guide"]',
      ),
    ).not.toBeNull();
    expect(text(el)).toContain(
      "All 340 products show a chart. New products get one when they match a display rule.",
    );
    expect(button(el, "Review display rules")?.getAttribute("href")).toBe(
      "/app/rules",
    );
  });

  it("shows the error state when the load fails outright", async () => {
    m.chartPages.mockReturnValue(pages([]));
    m.productCoverage.mockRejectedValue(new Error("unexpected"));
    const { home } = await load();
    home.catch(() => {});
    const el = await show(home);
    expect(
      el.querySelector(
        's-banner[heading="Your charts and numbers didn\'t load"]',
      ),
    ).not.toBeNull();
    expect(button(el, "Try again")).toBeDefined();
  });

  it("tells staff without Products access so under Home's title, and Try again loads Home once they have it", async () => {
    const el = await show(
      Promise.resolve({ error: { code: "access", message: "x" } }),
      Promise.resolve(OK),
    );
    expect(el.querySelector("s-page")?.getAttribute("heading")).toBe("Home");
    expect(banner(el)).toBe("You need Products access");
    expect(text(el)).toContain(
      "Fitted can't show this page without it. Ask the store owner to add it to your account in Settings › Users.",
    );
    expect(text(el)).not.toContain("Still not working?");
    await act(async () => button(el, "Try again")?.click());
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(text(el)).toContain("Women's tops");
  });

  it("leaves out the coverage card in a store with no products", async () => {
    const el = await show(
      Promise.resolve({
        ...OK,
        products: { all: N(0), covered: N(0), missing: [] },
      }),
    );
    expect(text(el)).toContain("Your charts");
    expect(
      el.querySelector('s-section[accessibilityLabel*="size guide"]'),
    ).toBeNull();
  });

  it("shows the returning merchant's setup guide, three of four done", async () => {
    m.extensions.mockResolvedValue(THEME_ON);
    const el = await show(Promise.resolve(OK));
    const t = text(el);
    expect(
      el.querySelector('s-section[accessibilityLabel="Setup guide"]')
        ?.textContent,
    ).toMatch(/^Setup guide3 of 4 done/);
    expect(
      el.querySelector('s-section[accessibilityLabel="Setup guide"] s-heading')
        ?.textContent,
    ).toBe("Setup guide");
    expect(t).toContain(
      "Turn on Fitted in your themeThe size guide app embed is on in your live theme.",
    );
    expect(t).toContain(
      "Move your charts from Kiwi12 charts imported. You can uninstall Kiwi once you've checked them.",
    );
    expect(t).toContain(
      "Choose which products show each chart312 of 340 products have a size guide.",
    );
    expect(t).toContain(
      "Add a fit finderHelp shoppers pick a size in three quick questions. Part of Pro, $15 a month.",
    );
    expect(t.indexOf("Turn on Fitted")).toBeLessThan(t.indexOf("Move your"));
    expect(button(el, "Upgrade to Pro")?.getAttribute("href")).toBe(
      "/app/fit-finder",
    );
    expect(button(el, "Open theme editor")).toBeUndefined();
    expect(t).not.toContain("Setup guide: all done");
  });

  it("offers the theme editor while the theme check hasn't found Fitted, or fails", async () => {
    for (const answer of [
      async () => [{ ...THEME_ON[0], activations: [{ status: "available" }] }],
      async () => {
        throw new Error("no bridge");
      },
    ]) {
      m.extensions.mockImplementation(answer);
      const el = await show(Promise.resolve(OK));
      expect(text(el)).toContain(
        "One switch in your theme editor. We'll take you there.",
      );
      const open = button(el, "Open theme editor");
      expect(open?.getAttribute("href")).toBe(OK.themeUrl);
      expect(open?.getAttribute("target")).toBe("_top");
      expect(text(el)).toContain("2 of 4 done");
    }
  });

  it("names the next step when products or the fit finder aren't done", async () => {
    const el = await show(
      Promise.resolve({
        ...OK,
        plan: "pro",
        imported: 0,
        products: { all: N(340), covered: N(0), missing: ["Socks"] },
      }),
    );
    const t = text(el);
    expect(t).toContain(
      "Add your first chartShoppers see a size guide on any product that has a chart.",
    );
    expect(t).not.toContain("Import charts");
    expect(t).toContain("Match by collection, tag, product type or vendor.");
    expect(
      [...el.querySelectorAll('s-button[href="/app/rules"]')].map(
        (b) => b.textContent,
      ),
    ).toEqual(["Add a display rule", "Add a display rule"]);
    expect(t).toContain(
      "Add a fit finderHelp shoppers pick a size in three quick questions.Set up fit finder",
    );
    expect(button(el, "Set up fit finder")?.getAttribute("href")).toBe(
      "/app/fit-finder",
    );
    expect(t).toContain("1 of 4 done");
  });

  it("counts one imported chart in the singular", async () => {
    const el = await show(Promise.resolve({ ...OK, imported: 1 }));
    expect(text(el)).toContain(
      "1 chart imported. You can uninstall Kiwi once you've checked them.",
    );
  });

  it("shows the first install's three ways to add a chart, first", async () => {
    const el = await show(
      Promise.resolve({
        ...OK,
        plan: "free",
        charts: 0,
        active: 0,
        imported: 0,
        rows: [],
        products: { all: N(340), covered: N(0), missing: [] },
      }),
    );
    const t = text(el);
    expect(t).toContain("0 of 4 done");
    expect(t.indexOf("Add your first chart")).toBeLessThan(
      t.indexOf("Turn on Fitted in your theme"),
    );
    expect(t).toContain(
      "Import from KiwiWe read the charts your store shows today. Free on every plan.Import charts",
    );
    expect(t).toContain(
      "Start from a templateTops, bottoms, dresses, shoes, kids and more.Choose a template",
    );
    expect(t).toContain(
      "Upload a CSVUse our template or any spreadsheet export.Upload CSV",
    );
    expect(
      ["Import charts", "Choose a template", "Upload CSV"].map((l) => [
        button(el, l)?.getAttribute("href"),
        button(el, l)?.getAttribute("variant"),
      ]),
    ).toEqual([
      ["/app/import", "primary"],
      ["/app/charts/new", "secondary"],
      ["/app/import", "secondary"],
    ]);
    expect(t).toContain(
      "Add a fit finderHelp shoppers pick a size in three quick questions. Part of Pro, $15 a month.",
    );
    expect(button(el, "Add a display rule")).toBeUndefined();
    expect(button(el, "Upgrade to Pro")).toBeUndefined();
    expect(button(el, "Open theme editor")?.getAttribute("href")).toBe(
      OK.themeUrl,
    );
  });

  it("folds the setup guide when Pro is all set up, and shows the steps again", async () => {
    m.extensions.mockResolvedValue(THEME_ON);
    const el = await show(
      Promise.resolve({
        ...OK,
        plan: "pro",
        fitLive: true,
        products: { all: N(340), covered: N(340), missing: [] },
      }),
    );
    expect(text(el)).toContain(
      "Setup guide: all doneEvery product has a size guide, and the fit finder is live.Show steps",
    );
    expect(text(el)).not.toContain("4 of 4 done");
    await act(async () => button(el, "Show steps")?.click());
    expect(text(el)).toContain("4 of 4 done");
    expect(text(el)).not.toContain("Setup guide: all done");
  });

  it("keeps the guide open while a product has no chart, even with every step done", async () => {
    m.extensions.mockResolvedValue(THEME_ON);
    const el = await show(
      Promise.resolve({ ...OK, plan: "pro", fitLive: true }),
    );
    expect(text(el)).toContain("4 of 4 done");
    expect(text(el)).not.toContain("Setup guide: all done");
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

// Regression (#171): a plan the database couldn't give failed Home's load, so
// it showed its error state. The shell and Home on their real loaders and the
// real plan read.
describe("when the database can't give the plan", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  afterEach(() => act(() => root?.unmount()));

  it("shows Home on Free under the plan banner, through Try again", async () => {
    const billing = await vi.importActual<
      typeof import("../models/billing.server")
    >("../models/billing.server");
    m.getPlan.mockImplementation(billing.getPlan);
    m.lastConfirmedPlan.mockImplementation(billing.lastConfirmedPlan);
    m.findUnique.mockRejectedValue(new Error("Can't reach database server"));
    m.chartPages.mockImplementation(() => pages([stored(1, "ACTIVE")]));
    const Stub = createRoutesStub([
      {
        path: "/app",
        Component: shell.default,
        HydrateFallback: () => null,
        loader: (args) => shell.loader(args as LoaderFunctionArgs),
        action: (args) => shell.action(args as ActionFunctionArgs),
        shouldRevalidate: shell.shouldRevalidate,
        children: [
          {
            index: true,
            Component: Home,
            loader: (args) => loader(args as LoaderFunctionArgs),
          },
        ],
      },
    ]);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    root = createRoot(el);
    await act(async () => root!.render(<Stub initialEntries={["/app"]} />));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    const headings = () =>
      [...el.querySelectorAll("s-banner")]
        .map((b) => b.getAttribute("heading"))
        .sort();
    const shown = [
      "Couldn't check your plan",
      "Free plan: 1 of 3 published charts",
    ];
    expect(headings()).toEqual(shown);
    expect(el.textContent).toContain(
      "Shopify didn't answer. Until it does, you keep Free and nothing is switched off.",
    );
    expect(el.textContent).toContain("Chart 1");

    const retry = el.querySelector(
      's-banner[heading="Couldn\'t check your plan"] s-button',
    ) as HTMLElement;
    const reads = m.getPlan.mock.calls.length;
    const homeReads = m.lastConfirmedPlan.mock.calls.length;
    await act(async () => retry.click());
    await act(() => new Promise((r) => setTimeout(r, 10)));
    // The re-check, then the shell's check and Home's load again: Home reads
    // the last confirmed plan, and the shell the banner's date.
    expect(m.getPlan.mock.calls.slice(reads)).toEqual([
      [SHOP, { recheck: true }],
      [SHOP],
    ]);
    expect(m.lastConfirmedPlan.mock.calls.slice(homeReads)).toEqual([
      [SHOP],
      [SHOP],
    ]);
    expect(headings()).toEqual(shown);
    expect(el.textContent).toContain("Chart 1");
  });
});

// What React Router does at entry.server.tsx's streamTimeout: whatever a
// loader streams that's still pending then is rejected, so its Await shows
// the error.
const STREAM_LIMIT = 5_000;
const streamed = async (loaded: Promise<object>) =>
  Object.fromEntries(
    Object.entries(await loaded).map(([key, value]) => [
      key,
      value instanceof Promise
        ? Promise.race([
            value,
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Server Timeout")),
                STREAM_LIMIT,
              ),
            ),
          ])
        : value,
    ]),
  );

// Regression (#193): a plan check slower than the stream (a slow Partner API,
// or a welcome-link re-check waiting out the 10-second gap) held Home's data
// past it, so Home showed its load error.
describe("when the plan check outlasts the stream", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows Home on the last confirmed plan, then on the plan the check settles on", async () => {
    // Only setTimeout: React schedules on setImmediate.
    vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
    m.chartPages.mockImplementation(() => pages([stored(1, "ACTIVE")]));
    m.lastConfirmedPlan.mockResolvedValue({
      plan: "free",
      yearly: false,
      at: null,
    });
    // Shopify answers after 6 seconds; the plan is cached from then on.
    const pro = { plan: "pro", yearly: false, checkFailed: false };
    m.getPlan.mockReturnValue(
      new Promise((resolve) =>
        setTimeout(() => {
          m.getPlan.mockResolvedValue(pro);
          m.lastConfirmedPlan.mockResolvedValue({ ...pro, at: new Date() });
          resolve(pro);
        }, 6_000),
      ),
    );
    // The shell's follow-up, through App Bridge's fetch.
    vi.stubGlobal("fetch", async (url: string) =>
      followUp.loader({
        request: new Request(new URL(url, "https://fitted.test")),
      } as LoaderFunctionArgs),
    );
    const Stub = createRoutesStub([
      {
        path: "/app",
        Component: shell.default,
        HydrateFallback: () => null,
        loader: (args) => streamed(shell.loader(args as LoaderFunctionArgs)),
        action: (args) => shell.action(args as ActionFunctionArgs),
        shouldRevalidate: shell.shouldRevalidate,
        children: [
          {
            index: true,
            Component: Home,
            loader: (args) => streamed(loader(args as LoaderFunctionArgs)),
          },
        ],
      },
    ]);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    root = createRoot(el);
    await act(async () => root!.render(<Stub initialEntries={["/app"]} />));
    const headings = () =>
      [...el.querySelectorAll("s-banner")].map((b) =>
        b.getAttribute("heading"),
      );

    await act(() => vi.advanceTimersByTimeAsync(STREAM_LIMIT));
    expect(headings()).toEqual(["Free plan: 1 of 3 published charts"]);
    expect(el.textContent).toContain("Chart 1");

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(headings()).toEqual(["Pro plan, $15 a month. No order fees."]);
    expect(el.textContent).toContain("Chart 1");
  });
});
