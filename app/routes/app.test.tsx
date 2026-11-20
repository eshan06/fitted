// @vitest-environment happy-dom
import type { ReactElement, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { action, loader, shouldRevalidate } from "./app";
import Import from "./app.import";

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
  it("shows a check still running after 4 seconds as not answered, with the cached plan", async () => {
    vi.useFakeTimers();
    try {
      m.getPlan.mockReturnValue(new Promise(() => {})); // Shopify hangs
      m.lastConfirmedPlan.mockResolvedValue({
        plan: "pro",
        at: new Date("2026-11-16T10:00:00Z"),
      });
      let check: unknown;
      void (await load()).plan.then((c) => (check = c));

      await vi.advanceTimersByTimeAsync(3_999);
      expect(check).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(check).toEqual({
        plan: "pro",
        checkFailed: true,
        confirmed: "Nov 16, 2026",
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
      checkFailed: true,
      confirmed: null,
    });
    expect(logs).toHaveLength(1);
  });

  it("reads as Free, unconfirmed, when the plan can't be read at all", async () => {
    m.getPlan.mockRejectedValue(new Error("database is down"));

    await expect((await load()).plan).resolves.toEqual({
      plan: "free",
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
  // The real loader and action, behind the mocked session and billing module.
  const show = async () => {
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
        ],
      },
    ]);
    const el = document.createElement("div");
    document.body.replaceChildren(el);
    await act(async () =>
      createRoot(el).render(<Stub initialEntries={["/app"]} />),
    );
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

  it("gives no date for a plan never confirmed, as on a new install", async () => {
    m.getPlan.mockResolvedValue({ plan: "free", checkFailed: true });
    m.lastConfirmedPlan.mockResolvedValue({ plan: "free", at: null });
    const el = await show();

    expect(banner(el)?.textContent).toContain(
      "Shopify didn't answer. Until it does, you keep Free and nothing is switched off.",
    );
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
