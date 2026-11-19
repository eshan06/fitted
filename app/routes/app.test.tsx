import type { ReactElement, ReactNode } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { loader } from "./app";
import Home from "./app._index";
import SizeCharts from "./app.charts._index";
import Import from "./app.import";
import DisplayRules from "./app.rules";
import FitFinder from "./app.fit-finder";
import Appearance from "./app.appearance";

const { admin } = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("../shopify.server", () => ({ authenticate: { admin } }));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useLoaderData: () => ({ apiKey: "test-api-key" }),
}));
vi.mock("@shopify/shopify-app-react-router/react", () => ({
  AppProvider: ({ children }: { children: ReactNode }) => children,
}));

const render = (element: ReactElement) =>
  renderToStaticMarkup(element).replaceAll("&amp;", "&");

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("admin shell", () => {
  it("authenticates the request and hands App Bridge the API key", async () => {
    vi.stubEnv("SHOPIFY_API_KEY", "test-api-key");
    admin.mockResolvedValue({});
    const request = new Request("https://fitted.test/app");

    await expect(loader({ request } as LoaderFunctionArgs)).resolves.toEqual({
      apiKey: "test-api-key",
    });
    expect(admin).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("passes the library's login redirect on, so no screen renders without a session", async () => {
    const login = new Response(null, {
      status: 302,
      headers: { Location: "/auth/login" },
    });
    admin.mockRejectedValue(login);
    const request = new Request("https://fitted.test/app/charts");

    await expect(loader({ request } as LoaderFunctionArgs)).rejects.toBe(login);
  });

  it("lists Fitted's screens in the canvas's order", () => {
    const links = [
      ...render(<App />).matchAll(/<s-link href="([^"]*)">([^<]*)<\/s-link>/g),
    ].map(([, href, label]) => [href, label]);

    expect(links).toEqual([
      ["/app", "Home"],
      ["/app/charts", "Size charts"],
      ["/app/import", "Import"],
      ["/app/rules", "Display rules"],
      ["/app/fit-finder", "Fit finder"],
      ["/app/appearance", "Appearance & languages"],
    ]);
  });
});

// The step that builds a screen deletes its row here and brings its own tests.
describe("placeholder screens", () => {
  it.each([
    ["Home", Home],
    ["Size charts", SizeCharts],
    ["Import charts", Import],
    ["Display rules", DisplayRules],
    ["Fit finder", FitFinder],
    ["Appearance & languages", Appearance],
  ])("%s is an empty page with the canvas's title", (title, Screen) => {
    expect(render(<Screen />)).toBe(`<s-page heading="${title}"></s-page>`);
  });
});
