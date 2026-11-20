// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const chart = {
  id: "gid://shopify/Metaobject/1",
  handle: "womens-tops",
  updatedAt: "2026-11-01T00:00:00Z",
  name: { value: "Women's tops" },
  capabilities: { publishable: { status: "ACTIVE" } },
};

// One shop's `$app.settings`, enforcing compareDigest like Shopify, and its
// charts. `down` makes every call fail.
function fakeStore(initial: Settings | null = null) {
  const store = {
    value: initial as Settings | null,
    digest: initial ? "d0" : null,
    writes: 0,
    down: false,
    chartsDown: false, // only the chart list fails
    charts: [chart],
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
