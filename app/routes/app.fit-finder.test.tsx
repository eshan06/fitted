// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRETCH } from "../lib/fit-finder";
import { defaultSettings, type Settings } from "../models/settings.server";

const m = vi.hoisted(() => ({ authenticate: vi.fn(), getPlan: vi.fn() }));
vi.mock("../shopify.server", () => ({
  authenticate: { admin: m.authenticate },
}));
vi.mock("../models/billing.server", () => ({ getPlan: m.getPlan }));
// The save bar is App Bridge's; here it renders its buttons in place.
vi.mock("@shopify/app-bridge-react", () => ({
  SaveBar: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="save-bar">{children}</div> : null,
}));
const { default: FitFinder, action, loader } = await import("./app.fit-finder");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SHOP = "fitted-dev.myshopify.com";
const PLANS =
  "https://admin.shopify.com/store/fitted-dev/charges/fitted/pricing_plans";
const json = (body: unknown) => new Response(JSON.stringify(body));
const TYPE = "app--1--chart";
const chart = {
  id: "gid://shopify/Metaobject/1",
  type: TYPE,
  handle: "womens-tops",
  updatedAt: "2026-11-01T00:00:00Z",
  name: { value: "Women's tops" },
  capabilities: { publishable: { status: "ACTIVE" } },
};
// A chart with questions: the FitFinder board's Women's tops.
const fitted = (n: number, name: string, ease: object = { bust: 2 }) => ({
  ...chart,
  id: `gid://shopify/Metaobject/${n}`,
  handle: `c-fitted000${n}`,
  name: { value: name },
  template: { value: "tops" },
  content: {
    jsonValue: {
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
          rows: ["xs", "s", "m", "l", "xl"].map((id, i) => ({
            id,
            cells: { bust: [33 + 2 * i, 34 + 2 * i] },
          })),
        },
      ],
      measure: { steps: [] },
      fit: {
        table: "t1",
        questions: [
          { id: "q1", kind: "measure", col: "bust", optional: true },
          { id: "q2", kind: "usual_size" },
          { id: "q3", kind: "fit" },
        ],
        ease,
        stretch: "some",
      },
      words: {
        "t1.bust": "Bust",
        "t1.xs.size": "XS",
        "t1.xl.size": "XL",
        "t1.m.size": "M",
        "t1.l.size": "L",
        "fit.q1": "What's your bust measurement?",
        "fit.q2": "What size do you usually wear?",
        "fit.q3": "How do you like tops to fit?",
      },
    },
  },
});
type Node = ReturnType<typeof fitted>;
const fitOf = (n: Node) => n.content.jsonValue.fit;

// One shop's `$app.settings`, enforcing compareDigest like Shopify, and its
// charts. `down` makes every call fail.
function fakeStore(initial: Settings | null = null) {
  const store = {
    value: initial as Settings | null,
    digest: initial ? "d0" : null,
    writes: 0,
    down: false,
    chartsDown: false, // only the chart list fails
    chartWritesDown: false,
    chartWritesMax: Infinity, // chart writes past this many fail
    chartReadsFresh: Infinity, // chart reads past this many see a newer save
    chartWrites: 0,
    charts: [chart] as (typeof chart | Node)[],
    products: {} as Record<string, number>, // by chart id
    countReads: 0,
  };
  const graphql = vi.fn(
    async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      if (store.down) throw new Error("socket hang up");
      if (query.includes("query ChartList"))
        return json({
          errors: store.chartsDown ? [{ message: "Throttled" }] : undefined,
          data: store.chartsDown
            ? undefined
            : {
                metaobjects: {
                  nodes: store.charts,
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
        });
      if (query.includes("query ChartGet")) {
        const found = store.charts.find((c) => c.id === opts!.variables!.id);
        const stale = store.chartReadsFresh-- <= 0;
        return json({
          data: {
            metaobject:
              found && stale
                ? { ...found, updatedAt: "later" }
                : (found ?? null),
            metaobjectDefinitionByType: { type: TYPE },
          },
        });
      }
      if (query.includes("mutation ChartUpdate")) {
        if (store.chartWritesDown || store.chartWrites >= store.chartWritesMax)
          throw new Error("socket hang up");
        const { id, metaobject } = opts!.variables as {
          id: string;
          metaobject: { values: { content: string } };
        };
        const i = store.charts.findIndex((c) => c.id === id);
        const node = {
          ...(store.charts[i] as Node),
          updatedAt: `2026-11-02T00:00:0${++store.chartWrites}Z`,
          content: { jsonValue: JSON.parse(metaobject.values.content) },
        };
        store.charts[i] = node;
        return json({
          data: { metaobjectUpdate: { metaobject: node, userErrors: [] } },
        });
      }
      if (query.includes("query ChartProductCounts")) {
        store.countReads++;
        const q = Object.entries(opts!.variables as Record<string, string>);
        const count = (v: string) => store.products[v.split('"')[1]] ?? 0;
        // Shopify counts up to 10,000.
        return json({
          data: Object.fromEntries(
            q.map(([k, v]) => [
              k.replace("q", "c"),
              {
                count: Math.min(count(v), 10000),
                precision: count(v) >= 10000 ? "AT_LEAST" : "EXACT",
              },
            ]),
          ),
        });
      }
      if (query.includes("query FittedAppHandle"))
        return json({
          data: { currentAppInstallation: { app: { handle: "fitted" } } },
        });
      if (query.includes("query FittedSettings"))
        return json({
          data: {
            shop: {
              id: "gid://shopify/Shop/1",
              metafield: store.value && {
                jsonValue: store.value,
                compareDigest: store.digest,
              },
            },
            shopLocales: [
              { locale: "fr", primary: false },
              { locale: "en", primary: true },
            ],
          },
        });
      const [mf] = opts!.variables!.metafields as {
        ownerId: string;
        value: string;
        compareDigest: string | null;
      }[];
      expect(mf.ownerId).toBe("gid://shopify/Shop/1");
      if (mf.compareDigest !== store.digest)
        return json({
          data: {
            metafieldsSet: {
              metafields: [],
              userErrors: [{ message: "Stale", code: "STALE_OBJECT" }],
            },
          },
        });
      store.value = JSON.parse(mf.value);
      store.digest = `d${++store.writes}`;
      return json({
        data: {
          metafieldsSet: {
            metafields: [{ compareDigest: store.digest }],
            userErrors: [],
          },
        },
      });
    },
  );
  return Object.assign(store, { admin: { graphql } });
}
// Stored settings with appearance edits and a second language the screen never edits.
const saved = (): Settings => {
  const s = defaultSettings("en");
  s.link.style = "button";
  s.text.en.label = "Fit guide";
  s.text.fr = { label: "Guide", header: "Tailles", noFit: "Aucune." };
  return s;
};

let store: ReturnType<typeof fakeStore>;
let logs: string[];
beforeEach(() => {
  vi.resetAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => logs.push(line));
  store = fakeStore(saved());
  m.authenticate.mockImplementation(async () => ({
    admin: store.admin,
    session: { shop: SHOP },
  }));
  m.getPlan.mockResolvedValue({ plan: "standard", checkFailed: false });
});
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const request = (body?: unknown) =>
  new Request("https://fitted.test/app/fit-finder", {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const load = async () => {
  const r = await loader({ request: request() } as LoaderFunctionArgs);
  return { ...r, fitFinder: await r.fitFinder };
};
const post = async (body: unknown) => {
  const r = (await action({
    request: request(body),
  } as ActionFunctionArgs)) as {
    type?: string;
    data?: unknown;
    init?: ResponseInit;
  };
  return r?.type === "DataWithResponseInit"
    ? { status: r.init?.status, body: r.data }
    : { status: 200, body: r };
};
const fitFinder = (patch: Partial<Settings["fitFinder"]> = {}) => ({
  ...saved().fitFinder,
  type: "basic" as const,
  answers: "sliders" as const,
  similar: true,
  ...patch,
});
const edits = (patch: Record<string, unknown> = {}) => ({
  fitFinder: fitFinder(),
  noFit: "Message us for a fitting.",
  ...patch,
});

describe("loading and saving the fit finder", () => {
  it("says the settings didn't load, logging why, when only the chart list fails", async () => {
    store.chartsDown = true;
    vi.useFakeTimers();
    const got = load();
    await vi.advanceTimersByTimeAsync(2_000); // its retries
    vi.useRealTimers();
    const { fitFinder } = await got;
    expect(fitFinder).toEqual({
      error: { code: "load", message: expect.any(String) },
    });
    expect(JSON.stringify(fitFinder)).not.toContain("Throttled");
    expect(JSON.parse(logs[0])).toMatchObject({
      level: "error",
      shop: SHOP,
      route: "app.fit-finder",
    });
  });

  it("loads the settings, the plan, the plans page and whether there are charts", async () => {
    const got = await load();
    expect(got.fitFinder).toMatchObject({
      settings: saved(),
      digest: "d0",
      primaryLocale: "en",
      plan: "standard",
      plansUrl: PLANS,
      hasCharts: true,
    });
    expect(got.storeUrl).toBe(`https://${SHOP}`);
    expect(m.getPlan).toHaveBeenCalledWith(SHOP);
  });

  it("saves the fit finder and its no-fit words, keeping appearance and other languages", async () => {
    expect(await post({ digest: "d0", edits: edits() })).toEqual({
      status: 200,
      body: { ok: true },
    });
    const s = (await load()).fitFinder as { settings: Settings };
    expect(s.settings.fitFinder).toEqual(fitFinder());
    expect(s.settings.text.en).toEqual({
      ...saved().text.en,
      noFit: "Message us for a fitting.",
    });
    expect(s.settings.text.fr).toEqual(saved().text.fr);
    expect(s.settings.link).toEqual(saved().link);
  });

  it("ignores anything but the digest and the edits from the browser", async () => {
    await post({
      digest: "d0",
      edits: { ...edits(), link: { style: "tab" }, text: {}, css: "x" },
      shopId: "gid://shopify/Shop/999",
      primaryLocale: "fr",
    });
    expect(store.value!.link).toEqual(saved().link);
    expect(store.value!.css).toBe("");
    expect(store.value!.text.fr).toEqual(saved().text.fr);
    expect(store.value!.text.en.noFit).toBe("Message us for a fitting.");
  });

  it("saves on any plan: set it up now, it goes live on Pro", async () => {
    m.getPlan.mockResolvedValue({ plan: "free", checkFailed: false });
    expect((await post({ digest: "d0", edits: edits() })).status).toBe(200);
  });

  it("refuses a save without a session before reading anything", async () => {
    m.authenticate.mockRejectedValue(new Response(null, { status: 401 }));
    await expect(post({ digest: "d0", edits: edits() })).rejects.toHaveProperty(
      "status",
      401,
    );
    expect(store.admin.graphql).not.toHaveBeenCalled();
  });

  it("answers 422 with the screen's field names, and writes nothing", async () => {
    const r = await post({
      digest: "d0",
      edits: edits({
        noFit: " ",
        fitFinder: { ...fitFinder({ type: "magic" as never }), extra: true },
      }),
    });
    expect(r.status).toBe(422);
    expect(
      Object.keys((r.body as { fieldErrors: object }).fieldErrors).sort(),
    ).toEqual(["fitFinder.extra", "fitFinder.type", "noFit"]);
    expect(store.writes).toBe(0);
  });

  it("answers 422 to a body that isn't the edits", async () => {
    expect((await post("nonsense")).status).toBe(422);
    expect(store.writes).toBe(0);
  });

  it("refuses a replayed save as changed since, so it never overwrites", async () => {
    const body = { digest: "d0", edits: edits() };
    await post(body);
    expect(await post({ ...body, edits: edits({ noFit: "Old" }) })).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: expect.stringContaining("nothing was overwritten"),
        },
      },
    });
    expect(store.writes).toBe(1);
    expect(store.value!.text.en.noFit).toBe("Message us for a fitting.");
  });

  it("answers 502 in the screen's words when Shopify fails, logging the cause", async () => {
    store.down = true;
    const r = await post({ digest: "d0", edits: edits() });
    expect(r.status).toBe(502);
    expect(r.body).toEqual({
      error: { code: "shopify", message: expect.any(String) },
      saved: { settings: false, charts: [] },
    });
    expect(JSON.stringify(r.body)).not.toContain("socket");
    expect(JSON.parse(logs[0])).toMatchObject({
      level: "error",
      shop: SHOP,
      route: "app.fit-finder",
    });
    expect((await load()).fitFinder).toMatchObject({
      error: { code: "load" },
    });
  });
});

// The screen, on the real loader and action over the fake store.
async function open() {
  const Stub = createRoutesStub([
    {
      path: "/app/fit-finder",
      Component: FitFinder,
      HydrateFallback: () => null,
      loader: (args) => loader(args as LoaderFunctionArgs),
      action: (args) => action(args as ActionFunctionArgs),
    },
  ]);
  const div = document.body.appendChild(document.createElement("div"));
  root = createRoot(div);
  await act(async () =>
    root!.render(<Stub initialEntries={["/app/fit-finder"]} />),
  );
  await settle();
}
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
const text = () => document.body.textContent ?? "";
const saveBar = () => document.querySelector('[data-testid="save-bar"]');
const noFit = () => document.getElementById("noFit") as HTMLInputElement;
const labelled = (label: string) =>
  [...document.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(label))!
    .querySelector("input, select") as HTMLInputElement;
const banners = () =>
  [...document.querySelectorAll("s-banner")].map((b) =>
    b.getAttribute("heading"),
  );
async function type(el: HTMLElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(
      new Event(el.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
const click = async (label: string | HTMLElement) => {
  const el =
    typeof label === "string"
      ? [...document.querySelectorAll<HTMLElement>("button, s-button")].find(
          (b) => b.textContent === label,
        )!
      : label;
  await act(async () => el.click());
  await settle();
};
const UPGRADE =
  "Fit finder is part of Pro, $15 a month. You're on Standard: set it up now and it goes live when you upgrade.";

describe("fit finder screen", () => {
  it("edits every control and saves, then reads back with the save bar closed", async () => {
    await open();
    expect(saveBar()).toBeNull();
    expect(labelled("Advanced").checked).toBe(true);
    await click(labelled("Basic"));
    await type(labelled("Answer style"), "sliders");
    await click(labelled("Suggest similar products"));
    await click(labelled("Show fit bars"));
    await click(labelled("Ask for age (Basic only)"));
    await type(noFit(), "Message us for a fitting.");
    expect(saveBar()).not.toBeNull();
    await click("Save");

    expect(store.value!.fitFinder).toEqual({
      ...saved().fitFinder,
      type: "basic",
      answers: "sliders",
      similar: true,
      fitBars: false,
      askAge: true,
    });
    expect(store.value!.text.en.noFit).toBe("Message us for a fitting.");
    expect(store.value!.link).toEqual(saved().link);
    expect(saveBar()).toBeNull();
    expect(labelled("Basic").checked).toBe(true);
  });

  it("offers Pro on Standard and Free, with the plans page, and not on Pro", async () => {
    await open();
    expect(banners()).toEqual([UPGRADE]);
    const upgrade = [...document.querySelectorAll("s-button")].find(
      (b) => b.textContent === "Upgrade to Pro",
    )!;
    expect(upgrade.getAttribute("href")).toBe(PLANS);
    expect(upgrade.getAttribute("target")).toBe("_top");
    // A banner's action button can't be primary: Shopify hides it (seen on the dev store).
    expect(upgrade.hasAttribute("variant")).toBe(false);
    act(() => root!.unmount());

    m.getPlan.mockResolvedValue({ plan: "free", checkFailed: false });
    await open();
    expect(banners()).toEqual([UPGRADE.replace("Standard", "Free")]);
    act(() => root!.unmount());

    m.getPlan.mockResolvedValue({ plan: "pro", checkFailed: false });
    await open();
    expect(banners()).toEqual([]);
    expect(text()).toContain("Fit finder type");
  });

  it("asks for a chart first when there are none", async () => {
    store.charts = [];
    await open();
    expect(text()).toContain("Nothing to measure against yet");
    expect(
      [...document.querySelectorAll("s-button")]
        .find((b) => b.textContent === "Create chart")!
        .getAttribute("href"),
    ).toBe("/app/charts/new");
    expect(text()).not.toContain("Fit finder type");
  });

  it("marks an empty no-fit message and sends nothing; Discard puts it back", async () => {
    await open();
    await type(noFit(), "  ");
    await click("Save");
    expect(store.writes).toBe(0);
    expect(banners()).toEqual(["Fix 1 field to save", UPGRADE]);
    expect(text()).toContain(
      "Nothing was saved, so your store hasn't changed.",
    );
    expect(text()).toContain("When no size fits is empty");
    expect(text()).toContain(
      "Enter a message for shoppers, up to 200 characters.",
    );
    expect(noFit().getAttribute("aria-invalid")).toBe("true");
    const link = [...document.querySelectorAll("a")].find(
      (a) => a.textContent === "When no size fits",
    )!;
    await act(async () => link.click());
    expect(document.activeElement).toBe(noFit());

    await click("Discard");
    expect(noFit().value).toBe(saved().text.en.noFit);
    expect(banners()).toEqual([UPGRADE]);
    expect(saveBar()).toBeNull();
  });

  it("shows changed elsewhere; Cancel keeps the edits, Reload latest discards them", async () => {
    await open();
    await type(noFit(), "Mine");
    store.digest = "other-tab"; // another tab saved
    store.value = {
      ...saved(),
      fitFinder: { ...saved().fitFinder, type: "custom" },
    };
    await click("Save");
    expect(banners()).toContain(
      "Fit finder settings changed since you opened them",
    );
    expect(text()).toContain(
      "Reload latest shows the newest settings and discards your edits.",
    );

    await click("Cancel");
    expect(banners()).toEqual([UPGRADE]);
    expect(noFit().value).toBe("Mine");

    await click("Save");
    await click("Reload latest");
    expect(banners()).toEqual([UPGRADE]);
    expect(noFit().value).toBe(saved().text.en.noFit);
    expect(labelled("Custom").checked).toBe(true);
    expect(saveBar()).toBeNull();
  });

  it("keeps the edits when the save fails, and Try saving again saves them", async () => {
    await open();
    await click(labelled("Custom"));
    store.down = true;
    await click("Save");
    expect(banners()).toContain("Your fit finder changes weren't saved");
    expect(labelled("Custom").checked).toBe(true);

    store.down = false;
    await click("Try saving again");
    expect(store.value!.fitFinder.type).toBe("custom");
    expect(banners()).toEqual([UPGRADE]);
  });

  it("says so when the settings don't load, and Try again loads them", async () => {
    store.down = true;
    await open();
    expect(banners()).toEqual(["Your fit finder settings didn't load"]);
    expect(text()).toContain("Still not working?");

    store.down = false;
    await click("Try again");
    expect(banners()).toEqual([UPGRADE]);
    expect(noFit().value).toBe(saved().text.en.noFit);
  });
});

describe("a chart's ease and stretch", () => {
  const TOPS = "gid://shopify/Metaobject/2";
  const BOTTOMS = "gid://shopify/Metaobject/3";
  const AT = chart.updatedAt;
  beforeEach(() => {
    store.charts = [
      chart,
      fitted(2, "Women's tops"),
      fitted(3, "Women's bottoms", {}),
    ];
  });
  const send = (charts: unknown) =>
    post({ digest: "d0", edits: edits(), charts });
  const tops = () => fitOf(store.charts[1] as Node);
  const none = () => expect(store.chartWrites + store.writes).toBe(0);

  it("loads only charts with questions, with their fit table and words", async () => {
    const got = (await load()).fitFinder as { charts: unknown[] };
    const { tables, words } = (store.charts[1] as Node).content.jsonValue;
    expect(got.charts).toEqual([
      {
        id: TOPS,
        updatedAt: AT,
        name: "Women's tops",
        unit: "in",
        fit: tops(),
        table: tables[0],
        words,
      },
      expect.objectContaining({ id: BOTTOMS }),
    ]);
  });

  it("saves through the chart's own write, keeping the rest of the chart", async () => {
    const r = await send([
      { id: TOPS, updatedAt: AT, ease: { bust: 1.5 }, stretch: "high" },
    ]);
    expect(r).toEqual({ status: 200, body: { ok: true } });
    const was = fitted(2, "").content.jsonValue;
    expect(tops()).toEqual({
      ...was.fit,
      ease: { bust: 1.5 },
      stretch: "high",
    });
    expect((store.charts[1] as Node).content.jsonValue.words).toEqual(
      was.words,
    );
    expect(store.chartWrites).toBe(1);
  });

  it("skips what already holds the edits, so a replay or a retry is no change", async () => {
    const body = [
      { id: TOPS, updatedAt: AT, ease: { bust: 1.5 }, stretch: "high" },
    ];
    await send(body);
    expect(await send(body)).toEqual({ status: 200, body: { ok: true } });
    expect(store.chartWrites).toBe(1);
    expect(store.writes).toBe(1); // the settings, once
  });

  it("answers 502 in the plain words when nothing landed", async () => {
    store.chartWritesDown = true;
    const r = await post({
      digest: "d0",
      edits: { fitFinder: saved().fitFinder, noFit: saved().text.en.noFit },
      charts: [{ id: TOPS, updatedAt: AT, ease: {}, stretch: "none" }],
    });
    expect(r).toMatchObject({
      status: 502,
      body: { error: { code: "shopify" } },
    });
    none();
  });

  it("offers Try saving again, not Reload latest, when a chart changes after the settings landed", async () => {
    store.chartReadsFresh = 1; // the write's own read sees another tab's save
    const r = await send([
      { id: TOPS, updatedAt: AT, ease: {}, stretch: "none" },
    ]);
    expect(r).toMatchObject({
      status: 502,
      body: { error: { code: "shopify" } },
    });
    expect(store.writes).toBe(1);
    expect(JSON.parse(logs[0])).toMatchObject({ route: "app.fit-finder" });
  });

  it("finishes on retry when one chart landed and the next failed", async () => {
    store.chartWritesMax = 1;
    const body = {
      digest: "d0",
      edits: { fitFinder: saved().fitFinder, noFit: saved().text.en.noFit },
      charts: [
        { id: TOPS, updatedAt: AT, ease: {}, stretch: "none" },
        { id: BOTTOMS, updatedAt: AT, ease: {}, stretch: "none" },
      ],
    };
    // What holds now, so the screen can say what saved; a retry that fails
    // again still counts what the first try saved.
    const held = { settings: true, charts: [TOPS] };
    for (let i = 0; i < 2; i++)
      expect(await post(body)).toMatchObject({
        status: 502,
        body: { error: { code: "shopify" }, saved: held },
      });
    store.chartWritesMax = Infinity;
    expect(await post(body)).toEqual({ status: 200, body: { ok: true } });
    expect(store.chartWrites).toBe(2);
    expect(fitOf(store.charts[2] as Node)).toMatchObject({ stretch: "none" });
  });

  it("writes a chart sent twice once", async () => {
    const one = { id: TOPS, updatedAt: AT, ease: { bust: 1 }, stretch: "high" };
    expect((await send([one, { ...one, ease: { bust: 3 } }])).status).toBe(200);
    expect(store.chartWrites).toBe(1);
    expect(tops()).toMatchObject({ ease: { bust: 1 } });
  });

  it("refuses a chart changed since it loaded, writing nothing", async () => {
    const stale = "2026-10-01T00:00:00Z";
    const r = await send([
      { id: TOPS, updatedAt: stale, ease: {}, stretch: "none" },
    ]);
    expect(r).toMatchObject({
      status: 409,
      body: { error: { code: "conflict" } },
    });
    none();
  });

  it("refuses a chart that isn't one of this shop's with questions", async () => {
    for (const id of [chart.id, "gid://shopify/Metaobject/99", "1", null]) {
      const r = await send([{ id, updatedAt: AT, ease: {}, stretch: "none" }]);
      expect(r.status).toBe(409);
    }
    none();
  });

  it("answers 422 with Ease marked for ease the chart can't hold, writing nothing", async () => {
    for (const ease of [{ size: 1 }, { bust: "2" }, { bust: 10000 }, null]) {
      const r = await send([
        { id: TOPS, updatedAt: AT, ease, stretch: "some" },
      ]);
      expect(r.status).toBe(422);
      const { fieldErrors } = r.body as { fieldErrors: object };
      expect(Object.keys(fieldErrors)).toEqual(["ease"]);
    }
    const bad = { id: TOPS, updatedAt: AT, ease: {}, stretch: "max" };
    expect((await send([bad])).status).toBe(422);
    none();
  });

  it("answers 502 when only the settings landed, logging why; the retry finishes it", async () => {
    store.chartWritesDown = true;
    const body = [{ id: TOPS, updatedAt: AT, ease: {}, stretch: "none" }];
    const r = await send(body);
    expect(r).toMatchObject({
      status: 502,
      body: { error: { code: "shopify" } },
    });
    expect(r.body).toMatchObject({ saved: { settings: true, charts: [] } });
    expect(JSON.stringify(r.body)).not.toContain("socket");
    expect(JSON.parse(logs[0])).toMatchObject({
      shop: SHOP,
      route: "app.fit-finder",
    });
    // The settings landed first, so the retry, on the same digest, skips them.
    expect(store.writes).toBe(1);
    store.chartWritesDown = false;
    expect(await send(body)).toEqual({ status: 200, body: { ok: true } });
    expect(store.writes).toBe(1);
    expect(tops()).toMatchObject({ ease: {}, stretch: "none" });
  });

  const ease = () => document.getElementById("ease") as HTMLInputElement;
  const picked = () => labelled("Recommend sizes from");
  const names = (el: HTMLElement, key: "value" | "textContent") =>
    [...el.querySelectorAll("option")].map((o) => o[key]);

  it("shows the picked chart's questions, ease and stretch, as the canvas draws them", async () => {
    await open();
    expect(picked().value).toBe(TOPS);
    expect(names(picked(), "textContent")).toEqual([
      "Women's tops",
      "Women's bottoms",
    ]);
    expect(
      [...document.querySelectorAll(".qs li")].map((li) => li.textContent),
    ).toEqual([
      "1What's your bust measurement?Number, optional. Links to How to measure.Edit",
      "2What size do you usually wear?Choice: XS to XL. Used when there's no measurement.Edit",
      "3How do you like tops to fit?Choice: Snug, Regular, RelaxedEdit",
    ]);
    expect(ease().value).toBe("+2 in at bust");
    // The engine's stretch levels, in the canvas's words.
    const stretch = labelled("Stretch");
    expect(names(stretch, "value")).toEqual(Object.keys(STRETCH));
    expect(names(stretch, "textContent")).toEqual([
      "None",
      "Some (linen blend)",
      "High",
    ]);
    expect(stretch.value).toBe("some");
  });

  it("keeps each chart's edits while switching, and saves every changed chart", async () => {
    await open();
    await type(ease(), "+1.5 in at bust");
    await type(picked(), BOTTOMS);
    expect(ease().value).toBe("");
    await type(labelled("Stretch"), "high");
    await type(picked(), TOPS);
    expect(ease().value).toBe("+1.5 in at bust");
    expect(saveBar()).not.toBeNull();
    await click("Save");

    expect(tops()).toMatchObject({ ease: { bust: 1.5 }, stretch: "some" });
    expect(fitOf(store.charts[2] as Node)).toMatchObject({
      ease: {},
      stretch: "high",
    });
    expect(store.writes).toBe(0); // the settings didn't change
    expect(saveBar()).toBeNull();
    expect(ease().value).toBe("+1.5 in at bust");
  });

  it("marks ease that doesn't read, on its chart, and sends nothing", async () => {
    await open();
    await type(ease(), "two inches");
    await type(picked(), BOTTOMS);
    await type(noFit(), "");
    await click("Save");
    none();
    expect(picked().value).toBe(TOPS);
    expect(banners()[0]).toBe("Fix 2 fields to save");
    expect(text()).toContain("Ease doesn't start with a number");
    expect(text()).toContain("When no size fits is empty");
    expect(text()).toContain("Start with a number, like +2 in at bust.");
    expect(ease().getAttribute("aria-invalid")).toBe("true");
    const link = [...document.querySelectorAll("a")].find(
      (a) => a.textContent === "Ease",
    )!;
    await act(async () => link.click());
    expect(document.activeElement).toBe(ease());
  });

  const PARTIAL = "Some of your changes weren't saved";
  const partial = () =>
    [...document.querySelectorAll("s-banner")]
      .find((b) => b.getAttribute("heading") === PARTIAL)
      ?.querySelectorAll("s-paragraph");
  const lines = () => [...(partial() ?? [])].map((p) => p.textContent);

  it("keeps the edits when a chart write fails after the settings, and Try saving again finishes", async () => {
    await open();
    await type(noFit(), "Message us.");
    await type(ease(), "+1 in at bust");
    store.chartWritesDown = true;
    await click("Save");
    expect(banners()).toEqual([PARTIAL, UPGRADE]);
    expect(lines()).toEqual([
      "Saved: your fit finder settings.",
      "Not saved: the ease and stretch for Women's tops. Your edits are still here.",
    ]);
    expect(partial()![0].querySelector("strong")!.textContent).toBe("Saved:");
    expect(ease().value).toBe("+1 in at bust");
    expect(store.value!.text.en.noFit).toBe("Message us.");

    // A retry that fails before it reads anything still counts what saved.
    store.down = true;
    await click("Try saving again");
    expect(banners()).toEqual([PARTIAL, UPGRADE]);
    expect(lines()[0]).toBe("Saved: your fit finder settings.");

    store.down = store.chartWritesDown = false;
    await click("Try saving again");
    expect(tops()).toMatchObject({ ease: { bust: 1 } });
    expect(store.writes).toBe(1);
    expect(banners()).toEqual([UPGRADE]);
  });

  it("names only the charts when the settings didn't change", async () => {
    await open();
    await type(ease(), "+1 in at bust");
    await type(picked(), BOTTOMS);
    await type(labelled("Stretch"), "high");
    store.chartWritesMax = 1;
    await click("Save");
    expect(lines()).toEqual([
      "Saved: the ease and stretch for Women's tops.",
      "Not saved: the ease and stretch for Women's bottoms. Your edits are still here.",
    ]);
  });

  it("names what saved and what didn't, as the canvas draws it, until the retry finishes", async () => {
    await open();
    await type(noFit(), "Message us.");
    await type(ease(), "+1 in at bust");
    await type(picked(), BOTTOMS);
    await type(labelled("Stretch"), "high");
    store.chartWritesMax = 1; // Women's tops lands, Women's bottoms doesn't
    const drawn = [
      "Saved: your fit finder settings, and the ease and stretch for Women's tops.",
      "Not saved: the ease and stretch for Women's bottoms. Your edits are still here.",
    ];
    await click("Save");
    expect(banners()).toEqual([PARTIAL, UPGRADE]);
    expect(lines()).toEqual(drawn);

    await click("Try saving again"); // fails again: the same lines
    expect(lines()).toEqual(drawn);
    expect(saveBar()).not.toBeNull();

    store.chartWritesMax = Infinity;
    await click("Try saving again");
    expect(banners()).toEqual([UPGRADE]);
    expect(fitOf(store.charts[2] as Node)).toMatchObject({ stretch: "high" });
    expect(store.writes).toBe(1);
    expect(store.chartWrites).toBe(2);
  });

  it("says only the plain words when nothing saved", async () => {
    await open();
    await type(ease(), "+1 in at bust");
    store.chartWritesDown = true;
    await click("Save");
    expect(banners()).toEqual([
      "Your fit finder changes weren't saved",
      UPGRADE,
    ]);
  });

  it("leaves the chart parts out when no chart has questions", async () => {
    store.charts = [chart];
    await open();
    expect(text()).toContain("Fit finder type");
    expect(text()).not.toContain("Recommend sizes from");
    expect(ease()).toBeNull();
    expect(text()).not.toContain("How Fitted picks a size");
    expect(text()).not.toContain("What shoppers see");
  });

  const rules = () =>
    [...document.querySelectorAll('[aria-labelledby="h-logic"] li')].map(
      (li) => li.textContent,
    );
  const preview = () =>
    document.querySelector('[aria-label="Shopper preview"]')!.textContent;
  // Women's tops runs XS 33-34 in bust to XL 41-42; the sample shopper is
  // M's 37.5 in, and the chart adds 2 in of ease.
  it("explains the picked chart's rules and previews findSize's pick for it", async () => {
    await open();
    expect(rules()).toEqual([
      "Match the shopper's bust measurement to the Women's tops chart.",
      "Relaxed fit moves one size up. Snug moves one size down, never below XS.",
      "No measurement? Start from the size they usually wear.",
    ]);
    expect(text()).toContain(
      "Shoppers always see why a size was picked, so they can trust it.",
    );
    expect(preview()).toBe(
      [
        "What shoppers seePreview",
        "Question 3 of 3Find my size",
        "How do you like tops to fit?SnugRegularRelaxedBackSee my size",
        "Your sizeL",
        "Your 37.5 in bust with 2 in of ease falls in L on this chart, and you like a regular fit.",
        "Select L",
      ].join(""),
    );
    expect(document.querySelector(".shopper .opt.on")!.textContent).toBe(
      "Regular",
    );
    // Nothing in the picture is a control.
    expect(
      document.querySelectorAll(
        ".shopper :is(button, input, select, a, s-button)",
      ),
    ).toHaveLength(0);

    await type(picked(), BOTTOMS);
    expect(rules()[0]).toBe(
      "Match the shopper's bust measurement to the Women's bottoms chart.",
    );
    expect(preview()).toContain(
      "Your 37.5 in bust falls in M on this chart, and you like a regular fit.Select M",
    );
  });

  it("previews the unsaved ease and stretch, and the no-fit words when nothing fits", async () => {
    await open();
    await type(ease(), "+5 in at bust"); // 42.5 in: past XL's 42
    expect(preview()).toContain(
      "Your 37.5 in bust with 5 in of ease falls in XL on this chart, counting the fabric's stretch",
    );
    await type(labelled("Stretch"), "none");
    expect(preview()).toContain(
      `${saved().text.en.noFit}Your 37.5 in bust with 5 in of ease is past XL, the largest size on this chart.`,
    );
    expect(preview()).not.toContain("Your size");
    await type(noFit(), "Message us for a fitting.");
    expect(preview()).toContain("Message us for a fitting.");
    // Ease that doesn't read yet previews the saved ease.
    await type(ease(), "+5 in at");
    await type(labelled("Stretch"), "some");
    expect(preview()).toContain("with 2 in of ease falls in L on this chart");
    none();
  });

  it("says on Pro how many products show the picked chart, in place of the upgrade", async () => {
    m.getPlan.mockResolvedValue({ plan: "pro", checkFailed: false });
    store.products = { [TOPS]: 148, [BOTTOMS]: 1 };
    await open();
    const live = () => document.querySelector(".live")!.textContent;
    expect(banners()).toEqual([]);
    expect(live()).toBe(
      "LiveFind my size shows on the 148 products with Women's tops. Changes go live when you save.",
    );
    expect(document.querySelector(".live")!.getAttribute("role")).toBe(
      "status",
    );
    await type(picked(), BOTTOMS);
    expect(live()).toBe(
      "LiveFind my size shows on the 1 product with Women's bottoms. Changes go live when you save.",
    );
    expect(store.countReads).toBe(1);
    act(() => root!.unmount());

    store.products = { [TOPS]: 12000 };
    await open();
    expect(live()).toContain("on the 10,000+ products with Women's tops.");
  });

  it("counts products only on Pro, keeping the upgrade elsewhere", async () => {
    await open();
    expect(store.countReads).toBe(0);
    expect(document.querySelector(".live")).toBeNull();
    expect(banners()).toEqual([UPGRADE]);
  });

  it("says the settings didn't load when Pro's product count fails", async () => {
    m.getPlan.mockResolvedValue({ plan: "pro", checkFailed: false });
    const graphql = store.admin.graphql.getMockImplementation()!;
    store.admin.graphql.mockImplementation(async (query, opts) =>
      query.includes("ChartProductCounts")
        ? json({ errors: [{ message: "Throttled" }] })
        : graphql(query, opts),
    );
    vi.useFakeTimers();
    const got = load();
    await vi.advanceTimersByTimeAsync(2_000); // its retries
    vi.useRealTimers();
    expect((await got).fitFinder).toEqual({
      error: { code: "load", message: expect.any(String) },
    });
  });
});

describe("the question editor", () => {
  const TOPS = "gid://shopify/Metaobject/2";
  const KIDS = "gid://shopify/Metaobject/4";
  const AT = chart.updatedAt;
  // A chart that reads but has no questions yet.
  const bare = () => {
    const n = fitted(4, "Kids");
    const content: Partial<Node["content"]["jsonValue"]> = {
      ...n.content.jsonValue,
    };
    delete content.fit;
    const words = Object.fromEntries(
      Object.entries(content.words!).filter(([k]) => !k.startsWith("fit.")),
    );
    return { ...n, content: { jsonValue: { ...content, words } } };
  };
  beforeEach(() => {
    store.charts = [fitted(2, "Women's tops"), bare() as unknown as Node];
  });
  const stored = (i: number) => (store.charts[i] as Node).content.jsonValue;
  const measure = { id: "q9", kind: "measure", col: "bust", optional: false };
  const send = (c: Record<string, unknown>) =>
    post({
      digest: "d0",
      edits: { fitFinder: saved().fitFinder, noFit: saved().text.en.noFit },
      charts: [{ id: KIDS, updatedAt: AT, ease: {}, stretch: "none", ...c }],
    });

  it("saves a chart's first questions and their words, keeping its other words", async () => {
    const words = { "fit.q9": "Your chest?", "t1.bust": "Hacked" };
    expect(await send({ questions: [measure], words })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(stored(1).fit).toEqual({
      table: "t1",
      questions: [measure],
      ease: {},
      stretch: "none",
    });
    // Only the questions' words come from the browser.
    expect(stored(1).words).toEqual({
      ...bare().content.jsonValue.words,
      "fit.q9": "Your chest?",
    });
    expect(store.chartWrites).toBe(1);
  });

  it("replaces the questions' words, so a removed question's words go", async () => {
    store.charts = [fitted(2, "Women's tops")];
    const q = fitted(2, "").content.jsonValue.fit.questions.slice(0, 2);
    const words = {
      "fit.q1": "Bust?",
      "fit.q2": "What size do you usually wear?",
    };
    const r = await post({
      digest: "d0",
      edits: { fitFinder: saved().fitFinder, noFit: saved().text.en.noFit },
      charts: [
        {
          id: TOPS,
          updatedAt: AT,
          ease: {},
          stretch: "none",
          questions: q,
          words,
        },
      ],
    });
    expect(r.status).toBe(200);
    expect(stored(0).fit.questions).toEqual(q);
    expect(
      Object.keys(stored(0).words).filter((k) => k.startsWith("fit.")),
    ).toEqual(["fit.q1", "fit.q2"]);
    expect(stored(0).words["fit.q1"]).toBe("Bust?");
  });

  it("writes the same questions once, so a replay or retry is no change", async () => {
    const body = { questions: [measure], words: { "fit.q9": "Chest?" } };
    await send(body);
    // A retry still carries the updatedAt the screen loaded.
    expect(await send(body)).toEqual({ status: 200, body: { ok: true } });
    expect(store.chartWrites).toBe(1);
  });

  it("answers 422 to questions the chart can't hold, writing nothing", async () => {
    const choice = (rows: string[]) => ({
      id: "q8",
      kind: "choice",
      options: [{ id: "a", rows }],
    });
    for (const questions of [
      [],
      Array.from({ length: 7 }, (_, i) => ({ ...measure, id: `q${i}` })),
      [{ ...measure, col: "size" }],
      [{ ...measure, kind: "height" }],
      [choice(["xxl"])],
      [choice([])],
      [{ ...measure, id: "t1" }], // the table's own id
      "q9",
    ]) {
      const r = await send({ questions, words: {} });
      expect(r.status).toBe(422);
    }
    expect(
      (await send({ questions: [measure], words: { "fit.x": "?" } })).status,
    ).toBe(422);
    expect(store.chartWrites + store.writes).toBe(0);
  });

  it("answers 422 to words that aren't an object, writing nothing", async () => {
    for (const words of [1, "fit.q9", null, []])
      expect((await send({ questions: [measure], words })).status).toBe(422);
    expect(store.chartWrites).toBe(0);
  });

  it("refuses questions for a chart changed since it loaded, even ones it can't hold now", async () => {
    const r = await send({
      updatedAt: "2026-10-01T00:00:00Z",
      questions: [{ ...measure, col: "gone" }],
      words: {},
    });
    expect(r).toMatchObject({
      status: 409,
      body: { error: { code: "conflict" } },
    });
    expect(store.chartWrites).toBe(0);
  });

  // The screen.
  const dialog = () => document.querySelector("dialog");
  const inDialog = (label: string) =>
    [...dialog()!.querySelectorAll<HTMLElement>("s-button")].find(
      (b) =>
        b.textContent === label ||
        b.getAttribute("accessibilityLabel") === label,
    )!;
  const edit = (n: number) =>
    document.querySelector<HTMLElement>(
      `[accessibilityLabel="Edit question ${n}"]`,
    )!;
  const listed = () =>
    [...document.querySelectorAll(".qs li strong")].map((s) => s.textContent);
  const kinds = () =>
    [...dialog()!.querySelectorAll("fieldset label strong")].map(
      (s) => s.textContent,
    );
  const check = async (el: HTMLInputElement) => act(async () => el.click());
  const useType = (t: string) =>
    check(
      [...document.querySelectorAll<HTMLInputElement>('input[name="type"]')][
        ["basic", "advanced", "custom"].indexOf(t)
      ],
    );

  it("edits a question in place, and Save writes it to the chart", async () => {
    await open();
    await click(edit(1));
    expect(dialog()!.querySelector("h2")!.textContent).toBe("Edit question 1");
    expect(labelled("Question").value).toBe("What's your bust measurement?");
    expect(labelled("Measurement").checked).toBe(true);
    expect(names(labelled("Chart column"))).toEqual(["Bust"]);
    expect(labelled("Optional").checked).toBe(true);
    expect(inDialog("Remove question")).toBeDefined();
    await type(labelled("Question"), "  Your bust?  ");
    await check(labelled("Optional"));
    await click(inDialog("Done"));
    expect(dialog()).toBeNull();
    expect(listed()[0]).toBe("Your bust?");
    expect(text()).toContain("Number. Links to How to measure.");
    await click("Save");
    expect(stored(0).fit.questions[0]).toEqual({
      id: "q1",
      kind: "measure",
      col: "bust",
      optional: false,
    });
    expect(stored(0).words["fit.q1"]).toBe("Your bust?");
    expect(saveBar()).toBeNull();
  });

  it("checks both fields before adding, and changes nothing until they pass", async () => {
    await open();
    await click("Add question");
    expect(dialog()!.querySelector("h2")!.textContent).toBe("Add question");
    expect(labelled("Question").value).toBe("");
    expect(labelled("Question").placeholder).toBe(
      "For example, What's your waist measurement?",
    );
    expect(names(labelled("Chart column"))).toEqual(["Pick a column", "Bust"]);
    expect(labelled("Optional").checked).toBe(false);
    expect(dialog()!.textContent).not.toContain("Remove question");
    await click(inDialog("Add question"));
    expect(dialog()!.textContent).toContain("Enter the question shoppers see.");
    expect(dialog()!.textContent).toContain("Pick the chart column to match.");
    expect(labelled("Question").getAttribute("aria-invalid")).toBe("true");
    expect(listed()).toHaveLength(3);
    expect(saveBar()).toBeNull();

    await type(labelled("Question"), "What's your waist?");
    await type(labelled("Chart column"), "bust");
    await click(inDialog("Add question"));
    expect(listed()).toEqual([
      "What's your bust measurement?",
      "What size do you usually wear?",
      "How do you like tops to fit?",
      "What's your waist?",
    ]);
    await click("Save");
    const added = stored(0).fit.questions[3];
    expect(added).toMatchObject({
      kind: "measure",
      col: "bust",
      optional: false,
    });
    expect(added.id).toMatch(/^[a-z0-9]{1,8}$/);
    const words = stored(0).words as Record<string, string>;
    expect(words[`fit.${added.id}`]).toBe("What's your waist?");
  });

  it("offers the kinds the fit finder type asks, keeping a question's own", async () => {
    await open();
    await click("Add question");
    expect(kinds()).toEqual(["Measurement", "Usual size", "Fit preference"]);
    await click(inDialog("Cancel"));
    await useType("basic");
    await click("Add question");
    expect(kinds()).toEqual(["Measurement", "Fit preference"]);
    await click(inDialog("Close"));
    await click(edit(2));
    expect(kinds()).toEqual(["Measurement", "Usual size", "Fit preference"]);
    await click(inDialog("Cancel"));
    await useType("custom");
    await click("Add question");
    expect(kinds()).toEqual([
      "Measurement",
      "Usual size",
      "Fit preference",
      "Choice",
    ]);
  });

  const answer = (n: number) =>
    dialog()!.querySelectorAll<HTMLElement>(".answer")[n - 1];
  const box = (n: number, size: string) =>
    [...answer(n).querySelectorAll("label")]
      .find((l) => l.textContent === size)!
      .querySelector("input")!;
  const ticked = (n: number) =>
    [...answer(n).querySelectorAll<HTMLInputElement>(".sizes input")].map(
      (i) => i.checked,
    );

  it("adds a choice question on Custom, checking each answer before it closes", async () => {
    await open();
    await useType("custom");
    await click("Add question");
    await type(labelled("Question"), "Which best describes your shoulders?");
    await check(labelled("Choice"));
    expect(dialog()!.querySelector(".answers legend")!.textContent).toBe(
      "Answers and the sizes they keep",
    );
    expect(dialog()!.textContent).toContain(
      "Shoppers who pick an answer only get its sizes.",
    );
    expect(dialog()!.querySelectorAll(".answer")).toHaveLength(1);
    expect(labelled("Answer 1").value).toBe("");
    expect(
      [...answer(1).querySelectorAll(".sizes label")].map((l) => l.textContent),
    ).toEqual(["XS", "s", "M", "L", "XL"]);
    expect(
      answer(1).querySelector('[role="group"]')!.getAttribute("aria-label"),
    ).toBe("Sizes for Answer 1");
    expect(inDialog("Remove answer Answer 1").hasAttribute("disabled")).toBe(
      true,
    );

    await click(inDialog("Add question"));
    expect(dialog()!.textContent).toContain("Enter the answer shoppers see.");
    expect(dialog()!.textContent).toContain(
      "Pick at least one size for this answer.",
    );
    expect(labelled("Answer 1").getAttribute("aria-invalid")).toBe("true");
    const group = answer(1).querySelector('[role="group"]')!;
    expect(
      document.getElementById(group.getAttribute("aria-describedby")!)!
        .textContent,
    ).toBe("Pick at least one size for this answer.");
    expect(listed()).toHaveLength(3);

    await type(labelled("Answer 1"), " Narrow ");
    await check(box(1, "s"));
    await check(box(1, "XS"));
    await click(inDialog("Add answer"));
    await type(labelled("Answer 2"), "Broad");
    expect(dialog()!.textContent).toContain(
      "Pick at least one size for this answer.",
    );
    await check(box(2, "XL"));
    expect(dialog()!.textContent).not.toContain("Pick at least one size");
    await click(inDialog("Add question"));
    expect(dialog()).toBeNull();
    expect(listed()[3]).toBe("Which best describes your shoulders?");
    expect(text()).toContain("Choice: Narrow, Broad");

    await click("Save");
    const added = stored(0).fit.questions[3] as unknown as {
      id: string;
      options: { id: string; rows: string[] }[];
    };
    expect(added).toMatchObject({
      kind: "choice",
      options: [{ rows: ["xs", "s"] }, { rows: ["xl"] }],
    });
    const [a, b] = added.options.map((o) => o.id);
    expect(a).toMatch(/^[a-z0-9]{1,8}$/);
    expect(a).not.toBe(b);
    expect(stored(0).words).toMatchObject({
      [`fit.${added.id}`]: "Which best describes your shoulders?",
      [`fit.${added.id}.${a}`]: "Narrow",
      [`fit.${added.id}.${b}`]: "Broad",
    });
  });

  it("stops adding answers at 20", async () => {
    await open();
    await useType("custom");
    await click("Add question");
    await check(labelled("Choice"));
    for (let i = 1; i < 20; i++) await click(inDialog("Add answer"));
    expect(dialog()!.querySelectorAll(".answer")).toHaveLength(20);
    expect(inDialog("Add answer").hasAttribute("disabled")).toBe(true);
  });

  it("edits a stored choice question's answers and sizes, dropping a removed answer's words", async () => {
    const n = fitted(2, "Women's tops");
    const jv = n.content.jsonValue as unknown as {
      fit: { questions: unknown[] };
      words: Record<string, string>;
    };
    jv.fit.questions[1] = {
      id: "q2",
      kind: "choice",
      options: [
        { id: "a", rows: ["xs", "m"] },
        { id: "b", rows: ["xl"] },
      ],
    };
    Object.assign(jv.words, { "fit.q2.a": "Narrow", "fit.q2.b": "Broad" });
    store.charts = [n];
    await open();
    await click(edit(2));
    expect(labelled("Choice").checked).toBe(true);
    expect(labelled("Answer 1").value).toBe("Narrow");
    expect(ticked(1)).toEqual([true, false, true, false, false]);
    expect(labelled("Answer 2").value).toBe("Broad");
    expect(ticked(2)).toEqual([false, false, false, false, true]);
    await type(labelled("Question"), "Your shoulders?");
    await type(labelled("Answer 1"), "Slim");
    await check(box(1, "s")); // lands between xs and m, in table order
    await click(inDialog("Remove answer Broad"));
    expect(dialog()!.querySelectorAll(".answer")).toHaveLength(1);
    await click(inDialog("Done"));
    await click("Save");
    expect(stored(0).fit.questions[1]).toEqual({
      id: "q2",
      kind: "choice",
      options: [{ id: "a", rows: ["xs", "s", "m"] }],
    });
    const words = stored(0).words as Record<string, string>;
    expect(words).toMatchObject({
      "fit.q2": "Your shoulders?",
      "fit.q2.a": "Slim",
    });
    expect(words["fit.q2.b"]).toBeUndefined();
  });

  it("drops a choice question's answers when it becomes another kind", async () => {
    const n = fitted(2, "Women's tops");
    const jv = n.content.jsonValue as unknown as {
      fit: { questions: unknown[] };
      words: Record<string, string>;
    };
    jv.fit.questions[1] = {
      id: "q2",
      kind: "choice",
      options: [{ id: "a", rows: ["m"] }],
    };
    jv.words["fit.q2.a"] = "Average";
    store.charts = [n];
    await open();
    await click(edit(2));
    await check(labelled("Fit preference"));
    expect(dialog()!.querySelector(".answers")).toBeNull();
    await click(inDialog("Done"));
    await click("Save");
    expect(stored(0).fit.questions[1]).toEqual({ id: "q2", kind: "fit" });
    expect(
      (stored(0).words as Record<string, string>)["fit.q2.a"],
    ).toBeUndefined();
  });

  it("removes a question with its words, never the only one", async () => {
    await open();
    await click(edit(2));
    await click(inDialog("Remove question"));
    expect(listed()).toHaveLength(2);
    await click("Save");
    expect(stored(0).fit.questions.map((q) => q.id)).toEqual(["q1", "q3"]);
    expect(stored(0).words["fit.q2"]).toBeUndefined();

    const one = fitted(2, "Women's tops");
    one.content.jsonValue.fit.questions.splice(1);
    delete (one.content.jsonValue.words as Record<string, string>)["fit.q2"];
    delete (one.content.jsonValue.words as Record<string, string>)["fit.q3"];
    store.charts = [one];
    act(() => root?.unmount());
    await open();
    await click(edit(1));
    expect(inDialog("Remove question").hasAttribute("disabled")).toBe(true);
  });

  it("discards the dialog's edits on Cancel and Close", async () => {
    await open();
    for (const how of ["Cancel", "Close"]) {
      await click(edit(1));
      await type(labelled("Question"), "Changed");
      await click(inDialog(how));
      expect(dialog()).toBeNull();
      expect(listed()[0]).toBe("What's your bust measurement?");
    }
    expect(saveBar()).toBeNull();
  });

  it("stops adding at 6 questions, saying so", async () => {
    await open();
    for (let i = 0; i < 3; i++) {
      await click("Add question");
      await type(labelled("Question"), `Question ${i}`);
      await check(labelled("Fit preference"));
      await click(inDialog("Add question"));
    }
    const add = [...document.querySelectorAll("s-button")].find(
      (b) => b.textContent === "Add question",
    )!;
    expect(add.hasAttribute("disabled")).toBe(true);
    expect(text()).toContain("A fit finder asks up to 6 questions.");
  });

  it("opens on a chart with questions, and on Pro calls only those live", async () => {
    store.charts.reverse(); // the bare chart first
    m.getPlan.mockResolvedValue({ plan: "pro", checkFailed: false });
    store.products = { [TOPS]: 148, [KIDS]: 5 };
    await open();
    expect(labelled("Recommend sizes from").value).toBe(TOPS);
    expect(document.querySelector(".live")).not.toBeNull();
    await type(labelled("Recommend sizes from"), KIDS);
    expect(document.querySelector(".live")).toBeNull();
  });

  it("gives a chart without questions its first, then shows its fit settings", async () => {
    await open();
    await type(labelled("Recommend sizes from"), KIDS);
    expect(listed()).toEqual([]);
    expect(document.getElementById("ease")).toBeNull();
    expect(text()).not.toContain("How Fitted picks a size");
    expect(text()).not.toContain("What shoppers see");
    await click("Add question");
    await type(labelled("Question"), "What's your chest?");
    await type(labelled("Chart column"), "bust");
    await click(inDialog("Add question"));
    expect(document.getElementById("ease")).not.toBeNull();
    expect(text()).toContain("How Fitted picks a size");
    await click("Save");
    expect(stored(1).fit).toMatchObject({
      table: "t1",
      questions: [{ kind: "measure", col: "bust", optional: false }],
    });
  });

  const names = (el: HTMLElement) =>
    [...el.querySelectorAll("option")].map((o) => o.textContent);
});
