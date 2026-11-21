// @vitest-environment happy-dom
import type { ReactElement, ReactNode } from "react";
import { Suspense, act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Await, Link, createRoutesStub, useLoaderData } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { action, loader, shouldRevalidate } from "./app";
import Import from "./app.import";
import { loader as followUp } from "./app.plan-check";

const m = vi.hoisted(() => ({
  admin: vi.fn(),
  getPlan: vi.fn(),
  lastConfirmedPlan: vi.fn(),
}));
vi.mock("../shopify.server", () => ({ authenticate: { admin: m.admin } }));
vi.mock("../models/billing.server", () => ({
  getPlan: m.getPlan,
  lastConfirmedPlan: m.lastConfirmedPlan,
}));
vi.mock("@shopify/shopify-app-react-router/react", () => ({
  AppProvider: ({ children }: { children: ReactNode }) => children,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SHOP = "fitted-dev.myshopify.com";
const render = (element: ReactElement) =>
  renderToStaticMarkup(element).replaceAll("&amp;", "&");
const load = (url = "https://fitted.test/app") =>
  loader({ request: new Request(url) } as LoaderFunctionArgs);

let logs: string[];
beforeEach(() => {
  vi.resetAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => logs.push(line));
  m.admin.mockResolvedValue({ session: { shop: SHOP } });
  m.getPlan.mockResolvedValue({ plan: "standard", checkFailed: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("admin shell", () => {
  it("authenticates the request, hands App Bridge the API key and checks the session's plan", async () => {
    vi.stubEnv("SHOPIFY_API_KEY", "test-api-key");
    const request = new Request("https://fitted.test/app");

    const data = await loader({ request } as LoaderFunctionArgs);
    expect(data.apiKey).toBe("test-api-key");
    await expect(data.plan).resolves.toEqual({
      plan: "standard",
      checkFailed: false,
      confirmed: null,
    });
    expect(m.admin).toHaveBeenCalledExactlyOnceWith(request);
    // A plain check: only the welcome link and Try again skip the cache.
    expect(m.getPlan).toHaveBeenCalledExactlyOnceWith(SHOP);
    expect(m.lastConfirmedPlan).not.toHaveBeenCalled();
  });

  it("gives the last confirmed plan and its date when the check fails", async () => {
    m.getPlan.mockResolvedValue({ plan: "standard", checkFailed: true });
    m.lastConfirmedPlan.mockResolvedValue({
      plan: "standard",
      at: new Date("2026-11-17T23:30:00Z"),
    });

    await expect((await load()).plan).resolves.toEqual({
      plan: "standard",
      checkFailed: true,
      confirmed: "Nov 17, 2026",
    });
    expect(m.lastConfirmedPlan).toHaveBeenCalledExactlyOnceWith(SHOP);
  });

  // React Router rejects what's still pending at entry.server.tsx's streamTimeout.
  it("hands a check still running after 4 seconds on to the follow-up, with the last confirmed plan", async () => {
    vi.useFakeTimers();
    try {
      m.getPlan.mockReturnValue(new Promise(() => {})); // Shopify hangs
      m.lastConfirmedPlan.mockResolvedValue({
        plan: "pro",
        yearly: true,
        at: new Date("2026-11-16T10:00:00Z"),
      });
      let check: unknown;
      void (await load()).plan.then((c) => (check = c));

      await vi.advanceTimersByTimeAsync(3_999);
      expect(check).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(check).toEqual({
        plan: "pro",
        yearly: true,
        checkFailed: true,
        confirmed: "Nov 16, 2026",
        pending: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the plan getPlan gave when the date can't be read", async () => {
    m.getPlan.mockResolvedValue({ plan: "standard", checkFailed: true });
    m.lastConfirmedPlan.mockRejectedValue(new Error("database is down"));

    await expect((await load()).plan).resolves.toEqual({
      plan: "standard",
      yearly: null,
      checkFailed: true,
      confirmed: null,
    });
    expect(logs).toHaveLength(1);
  });

  it("reads as Free, unconfirmed, when the plan can't be read at all", async () => {
    m.getPlan.mockRejectedValue(new Error("database is down"));

    await expect((await load()).plan).resolves.toEqual({
      plan: "free",
      yearly: null,
      checkFailed: true,
      confirmed: null,
    });
    expect(JSON.parse(logs[0])).toEqual({
      level: "error",
      msg: "Plan check failed",
      shop: SHOP,
      route: "app",
      error: "Error: database is down",
    });
  });

  it("re-checks at once on the welcome link, then loads the page without plan_handle", async () => {
    const thrown = await load(
      "https://fitted.test/app/charts?embedded=1&plan_handle=pro&host=abc",
    ).catch((r) => r);

    expect(thrown).toBeInstanceOf(Response);
    expect(thrown.status).toBe(302);
    expect(thrown.headers.get("Location")).toBe(
      "/app/charts?embedded=1&host=abc",
    );
    expect(m.getPlan).toHaveBeenCalledExactlyOnceWith(SHOP, { recheck: true });

    // A path that would read as another host stays on the app.
    const offsite = await load(
      "https://fitted.test//evil.test/app?plan_handle=pro",
    ).catch((r) => r);
    expect(offsite.headers.get("Location")).toBe("/evil.test/app");
  });

  // Only the shell's own loader: a screen that adds a loader authenticates in
  // it too (ARCHITECTURE §3), since a data request can skip this one.
  it("passes the library's login redirect on when there's no session", async () => {
    const login = new Response(null, {
      status: 302,
      headers: { Location: "/auth/login" },
    });
    m.admin.mockRejectedValue(login);

    await expect(load("https://fitted.test/app/charts")).rejects.toBe(login);
    await expect(
      action({
        request: new Request("https://fitted.test/app", { method: "POST" }),
      } as ActionFunctionArgs),
    ).rejects.toBe(login);
    expect(m.getPlan).not.toHaveBeenCalled();
  });

  it("re-checks the session's plan on Try again", async () => {
    const request = new Request("https://fitted.test/app", { method: "POST" });

    await expect(action({ request } as ActionFunctionArgs)).resolves.toBe(null);
    expect(m.admin).toHaveBeenCalledExactlyOnceWith(request);
    expect(m.getPlan).toHaveBeenCalledExactlyOnceWith(SHOP, { recheck: true });
  });
});

describe("the shell's screen", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  afterEach(() => act(() => root?.unmount()));
  let streamIn: (screen: string) => void = () => {};
  // The real loader and action, behind the mocked session and billing module.
  const show = async (path = "/app") => {
    const Stub = createRoutesStub([
      {
        path: "/app",
        Component: App,
        loader: (args) => loader(args as LoaderFunctionArgs),
        action: (args) => action(args as ActionFunctionArgs),
        shouldRevalidate,
        children: [
          {
            index: true,
            Component: () => (
              <s-page heading="Home">
                Home screen <Link to="/app/charts">Size charts</Link>
              </s-page>
            ),
          },
          {
            path: "charts",
            Component: () => (
              <s-page heading="Size charts">Charts screen</s-page>
            ),
          },
          {
            // Like Fit finder: a loading page of its own, swapped for the
            // screen's page once its data streams in after the plan's.
            path: "fit-finder",
            loader: () => ({
              data: new Promise((r) => (streamIn = r)),
            }),
            Component: () => (
              <Suspense fallback={<s-page heading="Loading">Loading</s-page>}>
                <Await resolve={useLoaderData().data}>
                  {(d) => <s-page heading="Fit finder">{d}</s-page>}
                </Await>
              </Suspense>
            ),
          },
        ],
      },
    ]);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    root = createRoot(el);
    await act(async () => root!.render(<Stub initialEntries={[path]} />));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    return el;
  };
  const banner = (el: Element) =>
    el.querySelector('s-banner[heading="Couldn\'t check your plan"]');
  const button = (el: Element, label: string) =>
    [...el.querySelectorAll("s-button")].find(
      (b) => b.textContent === label,
    ) as HTMLElement | undefined;

  it("lists Fitted's screens in the canvas's order", async () => {
    const el = await show();
    const links = [...el.querySelectorAll("s-app-nav s-link")].map((a) => [
      a.getAttribute("href"),
      a.textContent,
    ]);

    expect(links).toEqual([
      ["/app", "Home"],
      ["/app/charts", "Size charts"],
      ["/app/import", "Import"],
      ["/app/rules", "Display rules"],
      ["/app/fit-finder", "Fit finder"],
      ["/app/appearance", "Appearance & languages"],
    ]);
    expect(el.textContent).toContain("Home screen");
  });

  it("shows no banner when the plan is confirmed", async () => {
    const el = await show();
    expect(el.querySelector("s-banner")).toBeNull();
  });

  it("shows the canvas's warning when the check fails, and Try again re-checks", async () => {
    m.getPlan.mockResolvedValue({ plan: "standard", checkFailed: true });
    m.lastConfirmedPlan.mockResolvedValue({
      plan: "standard",
      at: new Date("2026-11-17T09:00:00Z"),
    });
    const el = await show();

    // Above the screen's content, in its page's slot for banners.
    expect(banner(el)?.parentElement?.getAttribute("heading")).toBe("Home");
    expect(banner(el)?.getAttribute("slot")).toBe("supplemental-start");
    expect(banner(el)?.getAttribute("tone")).toBe("warning");
    expect(banner(el)?.textContent).toContain(
      "Shopify didn't answer. Until it does, you keep Standard (last confirmed Nov 17, 2026) and nothing is switched off.",
    );
    expect(el.textContent).toContain("Home screen"); // the page still shows

    // Shopify answers this time: the loaders revalidate and the banner goes.
    m.getPlan.mockResolvedValue({ plan: "pro", checkFailed: false });
    await act(async () => button(el, "Try again")?.click());
    await act(() => new Promise((r) => setTimeout(r, 10)));

    expect(m.getPlan).toHaveBeenCalledWith(SHOP, { recheck: true });
    expect(banner(el)).toBeNull();
  });

  it("checks the plan again on every navigation between screens", async () => {
    const el = await show();
    expect(m.getPlan).toHaveBeenCalledTimes(1);

    m.getPlan.mockResolvedValue({ plan: "standard", checkFailed: true });
    m.lastConfirmedPlan.mockResolvedValue({ plan: "standard", at: null });
    await act(async () => el.querySelector("a")?.click());
    await act(() => new Promise((r) => setTimeout(r, 10)));

    expect(el.textContent).toContain("Charts screen");
    expect(m.getPlan).toHaveBeenCalledTimes(2);
    expect(banner(el)?.parentElement?.getAttribute("heading")).toBe(
      "Size charts",
    );
  });

  // Regression (#171): the banner stayed on the loading page, so it went with it.
  it("moves the banner to a screen's page when it replaces its loading page", async () => {
    m.getPlan.mockResolvedValue({ plan: "standard", checkFailed: true });
    m.lastConfirmedPlan.mockResolvedValue({ plan: "standard", at: null });
    const el = await show("/app/fit-finder");
    expect(banner(el)?.parentElement?.getAttribute("heading")).toBe("Loading");

    await act(async () => streamIn("Fit screen"));
    expect(el.textContent).toContain("Fit screen");
    expect(banner(el)?.parentElement?.getAttribute("heading")).toBe(
      "Fit finder",
    );
  });

  it("gives no date for a plan never confirmed, as on a new install", async () => {
    m.getPlan.mockResolvedValue({ plan: "free", checkFailed: true });
    m.lastConfirmedPlan.mockResolvedValue({ plan: "free", at: null });
    const el = await show();

    expect(banner(el)?.textContent).toContain(
      "Shopify didn't answer. Until it does, you keep Free and nothing is switched off.",
    );
  });
});

// #193: a screen loads with the last confirmed plan, and the shell settles a
// check slower than the stream after load.
describe("settling a check after load", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  type Shown = { plan: string; yearly: boolean | null };
  const at = (plan: string, yearly: boolean | null = false) => ({
    plan,
    yearly,
  });
  let screenLoads = 0;
  // The shell over a screen that loads with plans[0], then plans[1] once reloaded.
  const show = async (...plans: Shown[]) => {
    screenLoads = 0;
    const Stub = createRoutesStub([
      {
        path: "/app",
        Component: App,
        loader: (args) => loader(args as LoaderFunctionArgs),
        action: (args) => action(args as ActionFunctionArgs),
        shouldRevalidate,
        children: [
          {
            index: true,
            loader: () => ({
              planAtLoad: plans[Math.min(screenLoads++, plans.length - 1)],
            }),
            Component: () => (
              <s-page heading="Home">
                {`On ${useLoaderData<{ planAtLoad: Shown }>().planAtLoad.plan}`}
                <Link to="/app?again">Load again</Link>
              </s-page>
            ),
          },
        ],
      },
    ]);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    root = createRoot(el);
    await act(async () => root!.render(<Stub initialEntries={["/app"]} />));
    await settle();
    return el;
  };
  const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
  const banner = (el: Element) =>
    el.querySelector('s-banner[heading="Couldn\'t check your plan"]');
  const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  // Shopify answers after `ms`; App Bridge's fetch reaches the follow-up.
  const slowCheck = (state: object, ms = 6_000) => {
    vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
    m.getPlan.mockReturnValue(
      new Promise((resolve) => setTimeout(() => resolve(state), ms)),
    );
    const fetch = vi.fn(async (url: string) =>
      followUp({
        request: new Request(new URL(url, "https://fitted.test")),
      } as LoaderFunctionArgs),
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  it("asks again after load for a check still running, and leaves a screen on its plan as it is", async () => {
    const fetch = slowCheck({
      plan: "standard",
      yearly: false,
      checkFailed: false,
    });
    m.lastConfirmedPlan.mockResolvedValue({ plan: "standard", at: null });
    const el = await show(at("standard"));

    await wait(4_000);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/app/plan-check");
    await wait(2_000);
    expect(banner(el)).toBeNull();
    expect(el.textContent).toContain("On standard");
    expect(screenLoads).toBe(1);
  });

  it("shows the banner once the check it asked again for fails", async () => {
    slowCheck({ plan: "standard", checkFailed: true });
    m.lastConfirmedPlan.mockResolvedValue({
      plan: "standard",
      at: new Date("2026-11-17T09:00:00Z"),
    });
    const el = await show(at("standard"));

    await wait(4_000);
    expect(banner(el)).toBeNull(); // not while it's still checking
    await wait(2_000);
    expect(banner(el)?.textContent).toContain(
      "Shopify didn't answer. Until it does, you keep Standard (last confirmed Nov 17, 2026) and nothing is switched off.",
    );
    expect(el.textContent).toContain("On standard");
    expect(screenLoads).toBe(1);
  });

  it("reloads a screen that loaded with another plan once the check settles", async () => {
    slowCheck({ plan: "pro", yearly: false, checkFailed: false });
    m.lastConfirmedPlan.mockResolvedValue({ plan: "free", at: null });
    const el = await show(at("free"), at("pro"));

    await wait(6_000);
    await settle();
    expect(screenLoads).toBe(2);
    expect(el.textContent).toContain("On pro");
    expect(banner(el)).toBeNull();
  });

  it.each([
    ["fails", () => Promise.reject(new TypeError("offline")), 0],
    // Never read as the plan, whatever its body says.
    [
      "answers with an error",
      async () =>
        Response.json(
          { plan: "free", yearly: null, checkFailed: false },
          { status: 500 },
        ),
      0,
    ],
    ["takes over 30 seconds", () => new Promise(() => {}), 30_000],
  ])(
    "shows the banner on the last confirmed plan when the follow-up %s",
    async (_, answer, late) => {
      slowCheck({ plan: "pro", checkFailed: false }, 120_000);
      vi.stubGlobal("fetch", answer);
      m.lastConfirmedPlan.mockResolvedValue({
        plan: "pro",
        yearly: false,
        at: new Date("2026-11-16T10:00:00Z"),
      });
      const el = await show(at("pro"));

      await wait(4_000);
      if (late) {
        await wait(late - 1_000);
        expect(banner(el)).toBeNull(); // still waiting for it
        await wait(1_000);
      }
      await settle();
      expect(banner(el)?.textContent).toContain(
        "you keep Pro (last confirmed Nov 16, 2026) and nothing is switched off.",
      );
      expect(screenLoads).toBe(1);
    },
  );

  it("drops a follow-up's answer once the next load brings its own check", async () => {
    slowCheck({ plan: "standard", yearly: false, checkFailed: true });
    m.lastConfirmedPlan.mockResolvedValue({ plan: "standard", at: null });
    const el = await show(at("standard"));
    await wait(6_000);
    expect(banner(el)).not.toBeNull();

    // Try again: Shopify answers this time, and the loads that follow say so.
    m.getPlan.mockResolvedValue({
      plan: "standard",
      yearly: false,
      checkFailed: false,
    });
    await act(async () =>
      (banner(el)!.querySelector("s-button") as HTMLElement).click(),
    );
    await settle();
    expect(banner(el)).toBeNull();
  });

  it("keeps a later load's answer when an earlier load's lands after it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
    m.getPlan.mockReturnValue(new Promise(() => {})); // every load outlasts the stream
    m.lastConfirmedPlan.mockResolvedValue({ plan: "standard", at: null });
    const answers: ((r: Response) => void)[] = [];
    vi.stubGlobal("fetch", () => new Promise((r) => answers.push(r)));
    const reply = (checkFailed: boolean) =>
      new Response(
        JSON.stringify({ plan: "standard", yearly: false, checkFailed }),
      );
    const el = await show(at("standard"));
    await wait(4_000);
    await act(async () => el.querySelector("a")!.click());
    await wait(4_000);
    expect(answers).toHaveLength(2);

    await act(async () => answers[1](reply(true)));
    await settle();
    expect(banner(el)).not.toBeNull();
    await act(async () => answers[0](reply(false)));
    await settle();
    expect(banner(el)).not.toBeNull();
  });

  it("reloads a screen at once when a check inside the stream confirms another plan or price", async () => {
    vi.stubGlobal("fetch", vi.fn());
    m.getPlan.mockResolvedValue({
      plan: "pro",
      yearly: true,
      checkFailed: false,
    });
    let el = await show(at("free"), at("pro", true));
    expect(screenLoads).toBe(2);
    expect(el.textContent).toContain("On pro");
    act(() => root?.unmount());

    // Monthly to yearly changes Home's price.
    el = await show(at("pro", false), at("pro", true));
    expect(screenLoads).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a screen on Free as it is whatever its billing period, which Free never shows", async () => {
    m.getPlan.mockResolvedValue({
      plan: "free",
      yearly: false,
      checkFailed: false,
    });
    await show(at("free", null)); // a first install, never checked
    expect(screenLoads).toBe(1);
  });
});

describe("the plan check's follow-up", () => {
  const ask = (url = "https://fitted.test/app/plan-check") =>
    followUp({ request: new Request(url) } as LoaderFunctionArgs);

  it("waits for the session's shop's check, joining one already running, and answers with its plan", async () => {
    let answer: (state: object) => void = () => {};
    m.getPlan.mockReturnValue(new Promise((r) => (answer = r)));
    const asked = ask();
    let answered = false;
    void asked.then(() => (answered = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(answered).toBe(false);

    answer({ plan: "pro", yearly: true, checkFailed: false });
    const res = await asked;
    await expect(res.json()).resolves.toEqual({
      plan: "pro",
      yearly: true,
      checkFailed: false,
    });
    // One shop's plan as of now: never kept by a cache.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(m.admin).toHaveBeenCalledOnce();
    expect(m.getPlan).toHaveBeenCalledExactlyOnceWith(SHOP); // never a re-check
  });

  it("passes the library's login redirect on and reads no plan", async () => {
    const login = new Response(null, {
      status: 302,
      headers: { Location: "/auth/login" },
    });
    m.admin.mockRejectedValue(login);

    await expect(ask()).rejects.toBe(login);
    expect(m.getPlan).not.toHaveBeenCalled();
  });

  it("goes by the session's shop, never one in the address", async () => {
    await ask("https://fitted.test/app/plan-check?shop=other.myshopify.com");
    expect(m.getPlan).toHaveBeenCalledExactlyOnceWith(SHOP);
  });

  it("answers a repeat the same way, as a plain check each time", async () => {
    m.getPlan.mockResolvedValue({
      plan: "standard",
      yearly: false,
      checkFailed: true,
    });

    const first = await (await ask()).json();
    await expect((await ask()).json()).resolves.toEqual(first);
    expect(m.getPlan.mock.calls).toEqual([[SHOP], [SHOP]]);
  });
});

// The step that builds a screen deletes its row here and brings its own tests.
describe("placeholder screens", () => {
  it.each([["Import charts", Import]])(
    "%s is an empty page with the canvas's title",
    (title, Screen) => {
      expect(render(<Screen />)).toBe(`<s-page heading="${title}"></s-page>`);
    },
  );
});
