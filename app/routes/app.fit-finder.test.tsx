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
    chartWrites: 0,
    charts: [chart] as (typeof chart | Node)[],
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
      if (query.includes("query ChartGet"))
        return json({
          data: {
            metaobject:
              store.charts.find((c) => c.id === opts!.variables!.id) ?? null,
            metaobjectDefinitionByType: { type: TYPE },
          },
        });
      if (query.includes("mutation ChartUpdate")) {
        if (store.chartWritesDown) throw new Error("socket hang up");
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

  it("answers 502 when the chart write fails, logging why; the retry finishes it", async () => {
    store.chartWritesDown = true;
    const body = [{ id: TOPS, updatedAt: AT, ease: {}, stretch: "none" }];
    const r = await send(body);
    expect(r).toMatchObject({
      status: 502,
      body: { error: { code: "shopify" } },
    });
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
      "1What's your bust measurement?Number, optional. Links to How to measure.",
      "2What size do you usually wear?Choice: XS to XL. Used when there's no measurement.",
      "3How do you like tops to fit?Choice: Snug, Regular, Relaxed",
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
    // The question editor isn't drawn yet (#128).
    expect(text()).not.toContain("Add question");
    expect(text()).not.toContain("Edit");
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

  it("leaves the chart parts out when no chart has questions", async () => {
    store.charts = [chart];
    await open();
    expect(text()).toContain("Fit finder type");
    expect(text()).not.toContain("Recommend sizes from");
    expect(ease()).toBeNull();
  });
});
