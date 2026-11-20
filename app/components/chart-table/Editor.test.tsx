// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  type Location,
  type NavigateFunction,
  createRoutesStub,
  redirect,
  useLocation,
  useNavigate,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChartInput, validateChart } from "../../models/chart.server";

// The route's server half needs Shopify and the database; the screen doesn't.
vi.mock("../../shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../../db.server", () => ({ default: {} }));
const bridge = vi.hoisted(() => ({
  saveBar: { leaveConfirmation: vi.fn(), hide: vi.fn() },
  toast: { show: vi.fn() },
}));
// The save bar is App Bridge's; here it renders its buttons in place.
vi.mock("@shopify/app-bridge-react", () => ({
  SaveBar: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="save-bar">{children}</div> : null,
  useAppBridge: () => bridge,
}));
const { default: ChartEditor } = await import("../../routes/app.charts.$id");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const chart = (): ChartInput =>
  validateChart({
    name: "Women's tops",
    template: "tops",
    content: {
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
          rows: [{ id: "xs", cells: { bust: [31, 32] } }],
        },
      ],
      measure: { steps: [] },
      words: { "t1.size": "Size", "t1.bust": "Bust", "t1.xs.size": "XS" },
    },
  });
const stored = (updatedAt = "2026-11-19T10:00:00Z") => ({
  mode: "edit",
  stored: {
    id: "gid://shopify/Metaobject/42",
    status: "DRAFT",
    updatedAt,
    chart: chart(),
  },
});

let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  bridge.saveBar.leaveConfirmation.mockResolvedValue(undefined);
  bridge.saveBar.hide.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

// The router's address, and its Back (the browser's, in the admin).
let at: Location;
let nav: NavigateFunction;
function Editing() {
  at = useLocation();
  nav = useNavigate();
  return <ChartEditor />;
}
const back = async () => {
  await act(async () => nav(-1));
  await settle();
};

// Renders the editor route with a loader and an action that answer in turn.
async function open(
  loaded: unknown[],
  answers: ({ status: number; body: unknown } | { redirect: string })[] = [],
  path: string | string[] = "/app/charts/42",
) {
  const sent: Record<string, unknown>[] = [];
  const loader = vi.fn(
    () => loaded[Math.min(loader.mock.calls.length - 1, loaded.length - 1)],
  );
  const Stub = createRoutesStub([
    {
      path: "/app/charts/:id",
      Component: Editing,
      HydrateFallback: () => null,
      loader,
      action: async ({ request }) => {
        sent.push(await request.json());
        const a = answers.shift() ?? { status: 200, body: { ok: true } };
        if ("redirect" in a) return redirect(a.redirect);
        return Response.json(a.body, { status: a.status });
      },
    },
    // Where the editor's links lead.
    ...["/app/charts", "/app/fit-finder", "/app/charts/:id/history"].map(
      (p) => ({ path: p, Component: () => <p>Left for {p}</p> }),
    ),
  ]);
  const div = document.body.appendChild(document.createElement("div"));
  root = createRoot(div);
  await act(async () => root!.render(<Stub initialEntries={[path].flat()} />));
  await settle();
  return { sent, loader };
}
const missed = () =>
  document.querySelector('s-banner[tone="warning"]')?.getAttribute("heading");
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const text = () => document.body.textContent ?? "";
const byLabel = (label: string) =>
  document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const button = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("button, s-button")].find(
    (b) => b.textContent === label,
  )!;
async function type(el: HTMLInputElement | HTMLSelectElement, value: string) {
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
const click = async (label: string) => {
  await act(async () => button(label).click());
  await settle();
};

describe("chart editor screen", () => {
  it("edits the table, units and status, and saves them with the chart's updatedAt", async () => {
    const { sent } = await open([stored()]);
    expect(document.querySelector('[data-testid="save-bar"]')).toBeNull();
    await type(byLabel("XS, Bust"), "31.5–32");
    await act(async () => button("cm").click());
    await type(byLabel("Chart status"), "ACTIVE");
    await click("Save");
    expect(sent).toEqual([
      expect.objectContaining({
        status: "ACTIVE",
        updatedAt: "2026-11-19T10:00:00Z",
      }),
    ]);
    const c = (sent[0].chart as ChartInput).content;
    expect(c.unit).toBe("cm");
    expect(c.tables[0].rows[0].cells.bust).toEqual([31.5, 32]);
  });

  it("marks a wrong cell and saves nothing until it's fixed", async () => {
    const { sent } = await open([stored()]);
    await type(byLabel("XS, Bust"), "35–");
    await click("Save");
    expect(sent).toEqual([]);
    expect(text()).toContain(
      "Nothing was saved, so your store hasn't changed.",
    );
    expect(document.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "Fix 1 cell to save",
    );
    expect(text()).toContain("XS, Bust is missing the second number");
    expect(text()).toContain(
      "XS, Bust: Add the second number, like 35–36, or delete the dash.",
    );
    expect(byLabel("XS, Bust").getAttribute("aria-invalid")).toBe("true");
    await type(byLabel("XS, Bust"), "35–36");
    await click("Save");
    expect(sent).toHaveLength(1);
  });

  it("says a failed save changed nothing, keeps the edits, and tries again", async () => {
    const { sent } = await open(
      [stored()],
      [{ status: 502, body: { error: { code: "shopify", message: "x" } } }],
    );
    await type(byLabel("XS, Bust"), "33");
    await click("Save");
    expect(document.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "Your changes weren't saved",
    );
    expect(text()).toContain(
      "Shopify didn't respond in time, so the chart on your store hasn't changed. Your edits are still here.",
    );
    expect(byLabel("XS, Bust").value).toBe("33");
    await click("Try saving again");
    expect(sent).toHaveLength(2);
  });

  it("sends the new updatedAt after edits saved but the status didn't change", async () => {
    const { sent } = await open(
      [stored()],
      [
        {
          status: 502,
          body: {
            error: {
              code: "status",
              message:
                "Your edits were saved, but the chart is still a Draft. Change its status and save again.",
            },
            updatedAt: "2026-11-19T10:05:00Z",
          },
        },
      ],
    );
    await type(byLabel("Chart status"), "ACTIVE");
    await click("Save");
    expect(document.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "Edits saved, but the chart is still a Draft",
    );
    expect(text()).toContain(
      "Shopify didn't publish Women's tops, so shoppers can't see it yet.",
    );
    await click("Try publishing again");
    expect(sent[1]).toMatchObject({
      status: "ACTIVE",
      updatedAt: "2026-11-19T10:05:00Z",
    });
  });

  it("says a failed unpublish leaves the chart Published, and tries unpublishing again", async () => {
    const published = stored();
    published.stored.status = "ACTIVE";
    const { sent } = await open(
      [published],
      [
        {
          status: 502,
          body: {
            error: { code: "status", message: "x" },
            updatedAt: "2026-11-19T10:05:00Z",
          },
        },
      ],
    );
    await type(byLabel("Chart status"), "DRAFT");
    await click("Save");
    expect(document.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "Edits saved, but the chart is still Published",
    );
    expect(text()).toContain(
      "Shopify didn't unpublish Women's tops, so shoppers can still see it.",
    );
    await click("Try unpublishing again");
    expect(sent[1]).toMatchObject({ status: "DRAFT" });
  });

  it("treats the saved edits as the chart's content once only the status failed", async () => {
    const statusFailed = {
      status: 403,
      body: {
        error: { code: "product_access", message: "x" },
        updatedAt: "2026-11-19T10:05:00Z",
      },
    };
    await open([stored()], [statusFailed]);
    await type(byLabel("XS, Bust"), "33");
    await type(byLabel("Chart status"), "ACTIVE");
    await click("Save");
    expect(document.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "Edits saved, but the chart is still a Draft",
    );
    // The Rules board's "No access to products" words.
    expect(text()).toContain(
      "You need Products access to publish charts, since that also updates your products.",
    );
    expect(text()).toContain(
      "Ask the store owner to add Products access to your account in Settings › Users.",
    );
    expect(button("Try publishing again")).toBeDefined();
    // Discard goes back to what's stored now: the new cell, still a Draft.
    await click("Discard");
    expect(byLabel("XS, Bust").value).toBe("33");
    expect(byLabel("Chart status").value).toBe("DRAFT");
    expect(document.querySelector('[data-testid="save-bar"]')).toBeNull();
    expect(document.querySelector("s-banner")).toBeNull();
  });

  it.each([
    [false, ""],
    [true, "Couldn't check your plan, so Fitted counts it as Free."],
  ])(
    "names the Free limit, links the plans and saves as a Draft instead (plan check failed: %s)",
    async (checkFailed, first) => {
      const plansUrl =
        "https://admin.shopify.com/store/fitted-dev/charges/fitted-5/pricing_plans";
      const { sent } = await open(
        [stored()],
        [
          {
            status: 403,
            body: {
              error: {
                code: "plan_limit",
                message: "x",
                limit: 3,
                published: 3,
                checkFailed,
                plansUrl,
              },
            },
          },
        ],
      );
      await type(byLabel("XS, Bust"), "33");
      await type(byLabel("Chart status"), "ACTIVE");
      await click("Save");
      const banner = document.querySelector("s-banner")!;
      expect(banner.getAttribute("heading")).toBe(
        "Women's tops wasn't published",
      );
      expect(
        [...banner.querySelectorAll("s-paragraph")].map((p) => p.textContent),
      ).toEqual([
        ...(first ? [first] : []),
        "The Free plan allows 3 published charts and you have 3, so nothing was saved.",
        "Save it as a Draft, or see plans to publish more.",
      ]);
      const plans = button("See plans");
      expect(plans.getAttribute("href")).toBe(plansUrl);
      // A new tab, since the save bar holds this one while edits are unsaved.
      expect(plans.getAttribute("target")).toBe("_blank");
      expect(button("Try saving again")).toBeUndefined();
      await click("Save as Draft");
      expect(sent[1]).toMatchObject({ status: "DRAFT" });
      expect((sent[1].chart as ChartInput).content.tables[0].rows[0]).toEqual({
        id: "xs",
        cells: { bust: [33] },
      });
      expect(byLabel("Chart status").value).toBe("DRAFT");
    },
  );

  it("marks the fields the server refused", async () => {
    await open(
      [stored()],
      [
        {
          status: 422,
          body: {
            fieldErrors: {
              "content.tables.0.rows.0.cells.bust": "Use a number above 0",
            },
          },
        },
      ],
    );
    await type(byLabel("XS, Bust"), "33");
    await click("Save");
    expect(document.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "Fix 1 field to save",
    );
    expect(text()).toContain("XS, Bust: Use a number above 0");
    expect(byLabel("XS, Bust").getAttribute("aria-invalid")).toBe("true");
  });

  it("discards edits, and Cancel closes the changed-elsewhere banner", async () => {
    await open(
      [stored()],
      [{ status: 409, body: { error: { code: "conflict", message: "x" } } }],
    );
    await type(byLabel("XS, Bust"), "33");
    await click("Save");
    await click("Cancel");
    expect(document.querySelector("s-banner")).toBeNull();
    expect(byLabel("XS, Bust").value).toBe("33");
    await click("Discard");
    expect(byLabel("XS, Bust").value).toBe("31–32");
    expect(document.querySelector('[data-testid="save-bar"]')).toBeNull();
  });

  it("offers the latest version when the chart changed elsewhere", async () => {
    const { loader } = await open(
      [stored(), stored("2026-11-19T11:00:00Z")],
      [{ status: 409, body: { error: { code: "conflict", message: "x" } } }],
    );
    await type(byLabel("XS, Bust"), "33");
    await click("Save");
    expect(text()).toContain(
      "Your edits weren't saved, so nothing was overwritten.",
    );
    await click("Reload latest");
    expect(loader).toHaveBeenCalledTimes(2);
    expect(byLabel("XS, Bust").value).toBe("31–32");
    expect(document.querySelector("s-banner")).toBeNull();
  });

  const createJeans = async () => {
    await type(document.querySelector<HTMLInputElement>("#name")!, "Jeans");
    await act(async () => button("Add size").click());
    await type(byLabel("Size 1"), "28");
    await click("Save");
  };
  it("starts a new chart blank and creates it by its handle", async () => {
    const { sent } = await open(
      [{ mode: "new", handle: "c-abc" }],
      [],
      "/app/charts/new",
    );
    expect(text()).toContain("New chart");
    expect(text()).toContain("A blank chart, ready for sizes");
    expect(document.querySelector('[aria-label="Chart status"]')).toBeNull();
    await createJeans();
    expect(sent).toEqual([
      { handle: "c-abc", chart: expect.objectContaining({ name: "Jeans" }) },
    ]);
  });

  const newChart = { mode: "new", handle: "c-abc" };
  it("hides the save bar, then replaces the address with the new chart's own", async () => {
    // The admin keeps its address bar while the save bar shows (App Bridge's Navigation API).
    let hidden = () => {};
    bridge.saveBar.hide.mockImplementation(
      () => new Promise<void>((r) => (hidden = r)),
    );
    // The create's revalidation mints a fresh handle; then the chart loads.
    const { loader } = await open(
      [newChart, { ...newChart, handle: "c-def" }, stored()],
      [{ status: 200, body: { created: "42" } }],
      ["/app/charts", "/app/charts/new"],
    );
    await createJeans();
    expect(bridge.saveBar.hide).toHaveBeenCalledWith("chart-save-bar");
    expect(at.pathname).toBe("/app/charts/new");
    await act(async () => hidden());
    await settle();
    expect(at.pathname).toBe("/app/charts/42");
    expect(loader).toHaveBeenCalledTimes(3);
    expect(byLabel("XS, Bust").value).toBe("31–32");
    // Replaced, so Back skips the blank new chart.
    await back();
    expect(text()).toContain("Left for /app/charts");
  });

  it("opens a new chart saying history missed it", async () => {
    await open(
      [newChart, newChart, stored()],
      [{ status: 200, body: { created: "42", historyMissed: true } }],
      "/app/charts/new",
    );
    await createJeans();
    expect(at.pathname).toBe("/app/charts/42");
    expect(missed()).toBe("Saved, but version history missed it");
  });

  it("still opens a new chart when the save bar won't hide", async () => {
    bridge.saveBar.hide.mockRejectedValue(new Error("no admin"));
    await open(
      [newChart, newChart, stored()],
      [{ status: 200, body: { created: "42" } }],
      "/app/charts/new",
    );
    await createJeans();
    await settle();
    expect(at.pathname).toBe("/app/charts/42");
    expect(byLabel("XS, Bust").value).toBe("31–32");
  });

  it("stays where the merchant went when they leave before the save bar hides", async () => {
    let hidden = () => {};
    bridge.saveBar.hide.mockImplementation(
      () => new Promise<void>((r) => (hidden = r)),
    );
    await open(
      [newChart, newChart],
      [{ status: 200, body: { created: "42" } }],
      "/app/charts/new",
    );
    await createJeans();
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>("a")]
        .find((a) => a.textContent === "Size charts")!
        .click(),
    );
    await settle();
    await act(async () => hidden());
    await settle();
    expect(text()).toContain("Left for /app/charts");
  });

  it("links More actions to the chart's version history, except on a new chart", async () => {
    await open([stored()]);
    const link = [...document.querySelectorAll("details.more a")].find(
      (a) => a.textContent === "Version history",
    );
    expect(link?.getAttribute("href")).toBe("/app/charts/42/history");
    act(() => root?.unmount());
    await open([{ mode: "new", handle: "c-abc" }], [], "/app/charts/new");
    expect(text()).not.toContain("More actions");
  });

  it("says when a save landed but version history missed it, until a save that history keeps", async () => {
    // Each save stores a new updatedAt, so the reload rebuilds the editor;
    // the note's leaving the address reloads the same chart once more.
    const saved = stored("2026-11-19T10:05:00Z");
    await open(
      [stored(), saved, saved, stored("2026-11-19T10:06:00Z")],
      [
        { redirect: "/app/charts/42?history=missed" },
        { status: 200, body: { ok: true } },
      ],
    );
    expect(missed()).toBeUndefined();
    await type(byLabel("XS, Bust"), "31.5–32");
    await click("Save");
    expect(missed()).toBe("Saved, but version history missed it");
    // Word for word as drawn on the canvas's Editor board.
    expect(text()).toContain(
      "The chart on your store is up to date. This save won't show in version history.",
    );
    await type(byLabel("XS, Bust"), "30–32");
    await click("Save");
    expect(missed()).toBeUndefined();
  });

  it("says so when the edits saved, the status didn't, and history missed it", async () => {
    await open(
      [stored()],
      [
        {
          status: 502,
          body: {
            error: { code: "status", message: "x" },
            updatedAt: "2026-11-19T10:05:00Z",
            historyMissed: true,
          },
        },
      ],
    );
    await type(byLabel("Chart status"), "ACTIVE");
    await click("Save");
    expect(missed()).toBe("Saved, but version history missed it");
  });

  it("opens a new chart whose first version wasn't recorded saying so, once", async () => {
    const { loader } = await open(
      [stored()],
      [{ status: 502, body: { error: { code: "shopify", message: "x" } } }],
      "/app/charts/42?history=missed&host=abc",
    );
    expect(missed()).toBe("Saved, but version history missed it");
    // The note leaves the address, so a reload doesn't repeat it.
    const calls = loader.mock.calls as unknown as [{ request: Request }][];
    expect(calls.at(-1)?.[0].request.url).toBe(
      "http://localhost/app/charts/42?host=abc",
    );
    // The next save's answer replaces it: this one changed nothing.
    await type(byLabel("XS, Bust"), "30–32");
    await click("Save");
    expect(missed()).toBeUndefined();
  });

  it("says when the chart didn't load, and tries again", async () => {
    const { loader } = await open([
      { mode: "error", error: { code: "shopify", message: "x" } },
      stored(),
    ]);
    expect(document.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "This chart didn't load",
    );
    await click("Try again");
    expect(loader).toHaveBeenCalledTimes(2);
    expect(byLabel("XS, Bust").value).toBe("31–32");
  });

  it("shows the loading state while it tries again", async () => {
    let finish = () => {};
    const slow = new Promise<void>((r) => (finish = r)).then(() => stored());
    await open([{ mode: "error", error: { code: "shopify" } }, slow]);
    await act(async () => button("Try again").click());
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Loading chart",
    );
    await act(async () => finish());
    await settle();
    expect(byLabel("XS, Bust").value).toBe("31–32");
  });

  it("names how many saved values fail the checks", async () => {
    await open([
      {
        mode: "edit",
        stored: {
          id: "gid://shopify/Metaobject/42",
          status: "ACTIVE",
          updatedAt: "2026-11-19T10:00:00Z",
          fieldErrors: { "content.v": "Must be 1", name: "Must be text" },
        },
      },
    ]);
    expect(document.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "Fix 2 values to save this chart",
    );
    expect(text()).toContain(
      "They were changed outside Fitted. Nothing on your store has changed.",
    );
    expect(document.querySelector("input")).toBeNull();
  });

  // A stored chart with XS, Bust saved as 32–31, and the server's findings.
  const broken = (fieldErrors: Record<string, string> = {}) => {
    const raw = chart();
    raw.content.tables[0].rows[0].cells.bust = [32, 31];
    return {
      mode: "edit",
      stored: {
        id: "gid://shopify/Metaobject/42",
        status: "DRAFT",
        updatedAt: "2026-11-19T10:00:00Z",
        fieldErrors: {
          "content.tables.0.rows.0.cells.bust": "Use a range from low to high",
          ...fieldErrors,
        },
        raw,
      },
    };
  };

  it("keeps the server's own findings listed, and Discard brings the banner back", async () => {
    await open([broken({ "content.words.t1.xs.size": "Too long" })]);
    expect(document.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "Fix 2 values to save this chart",
    );
    expect(text()).toContain("Size 1: Too long");
    await type(byLabel("Size 1"), "");
    await click("Save");
    expect(document.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "Fix 2 fields to save",
    );
    await click("Discard");
    expect(document.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "Fix 2 values to save this chart",
    );
    expect(byLabel("XS, Bust").value).toBe("32–31");
  });

  it("shows only the banner when a finding is outside what the editor can change", async () => {
    await open([broken({ "content.roundTo": "Pick 0.25, 0.5 or 1" })]);
    expect(document.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "Fix 2 values to save this chart",
    );
    expect(document.querySelector("input")).toBeNull();
  });

  it("drops the opening banner once the fixed chart is stored, even if the status then fails", async () => {
    await open(
      [broken()],
      [
        {
          status: 403,
          body: {
            error: { code: "product_access", message: "x" },
            updatedAt: "2026-11-19T10:05:00Z",
          },
        },
      ],
    );
    await type(byLabel("XS, Bust"), "31–32");
    await type(byLabel("Chart status"), "ACTIVE");
    await click("Save");
    await click("Discard");
    expect(document.querySelector("s-banner")).toBeNull();
    expect(byLabel("XS, Bust").value).toBe("31–32");
    expect(byLabel("XS, Bust").getAttribute("aria-invalid")).toBeNull();
  });

  it("leaves out See plans when the server couldn't read the link", async () => {
    await open(
      [stored()],
      [
        {
          status: 403,
          body: {
            error: { code: "plan_limit", message: "x", limit: 3, published: 3 },
          },
        },
      ],
    );
    await type(byLabel("Chart status"), "ACTIVE");
    await click("Save");
    expect(button("Save as Draft")).toBeDefined();
    expect(button("See plans")).toBeUndefined();
  });

  it("asks for Products access to unpublish too", async () => {
    const published = stored();
    published.stored.status = "ACTIVE";
    await open(
      [published],
      [
        {
          status: 403,
          body: {
            error: { code: "product_access", message: "x" },
            updatedAt: "2026-11-19T10:05:00Z",
          },
        },
      ],
    );
    await type(byLabel("Chart status"), "DRAFT");
    await click("Save");
    expect(text()).toContain(
      "You need Products access to unpublish charts, since that also updates your products.",
    );
    expect(button("Try unpublishing again")).toBeDefined();
  });

  it("opens a saved chart that fails the checks with its bad values marked, and saves once they're fixed", async () => {
    const { sent } = await open([broken()]);
    const banner = document.querySelector("s-banner")!;
    expect(banner.getAttribute("heading")).toBe(
      "Fix 1 value to save this chart",
    );
    expect(banner.textContent).toContain(
      "They were changed outside Fitted. Nothing on your store has changed.",
    );
    // The editor's own words, linked to the cell.
    expect(banner.querySelector("a")?.getAttribute("href")).toBe(
      "#cell-xs-bust",
    );
    expect(banner.textContent).toContain("XS, Bust runs from high to low");
    expect(text()).toContain(
      "XS, Bust: Put the smaller number first, like 31–32.",
    );
    expect(byLabel("XS, Bust").value).toBe("32–31");
    expect(byLabel("XS, Bust").getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector('[data-testid="save-bar"]')).toBeNull();
    await type(byLabel("XS, Bust"), "31–32");
    await click("Save");
    expect(sent).toHaveLength(1);
  });

  // A stored chart whose US size column holds numbers, written outside Fitted.
  const numbersInText = () => {
    const raw = chart() as unknown as {
      content: {
        tables: { columns: object[]; rows: { id: string; cells: object }[] }[];
        words: Record<string, string>;
      };
    };
    const t = raw.content.tables[0];
    t.columns.push({ id: "us", kind: "country", country: "US" });
    t.rows.push({ id: "s", cells: { us: [6] } });
    t.rows[0].cells = { ...t.rows[0].cells, us: [2] };
    Object.assign(raw.content.words, { "t1.us": "US size", "t1.s.size": "S" });
    return {
      mode: "edit",
      stored: {
        id: "gid://shopify/Metaobject/42",
        status: "DRAFT",
        updatedAt: "2026-11-19T10:00:00Z",
        fieldErrors: {
          "content.tables.0.rows.0.cells.us": "Not a measurement column",
          "content.tables.0.rows.1.cells.us": "Not a measurement column",
        },
        raw,
      },
    };
  };

  it("warns before a save drops stored numbers in a country column, and keeps them once retyped", async () => {
    const { sent } = await open([numbersInText()]);
    const warn = document.querySelector('s-banner[tone="warning"]')!;
    expect(warn.getAttribute("heading")).toBe(
      "Saving drops 2 values in US size",
    );
    expect(warn.textContent).toContain(
      "They were added outside Fitted as numbers, which this column can't hold: 2 (XS) and 6 (S).",
    );
    expect(warn.textContent).toContain("Type them in again to keep them.");
    // The drop warning stands in for the checks' banner on these values.
    expect(document.querySelector('s-banner[tone="critical"]')).toBeNull();
    expect(byLabel("XS, US size").className).toContain("drop");
    await type(byLabel("XS, US size"), "2");
    expect(missed()).toBe("Saving drops 1 value in US size");
    expect(text()).toContain("Type it in again to keep it.");
    await type(byLabel("S, US size"), "6");
    expect(missed()).toBeUndefined();
    await click("Save");
    const c = (sent[0].chart as ChartInput).content;
    expect(c.words).toMatchObject({ "t1.xs.us": "2", "t1.s.us": "6" });
    expect(c.tables[0].rows.map((r) => r.cells)).toEqual([
      { bust: [31, 32] },
      {},
    ]);
  });

  it("drops the warning once the edits are stored, even when the status then fails", async () => {
    await open(
      [numbersInText()],
      [
        {
          status: 502,
          body: {
            error: { code: "status", message: "Still a Draft" },
            updatedAt: "2026-11-19T10:05:00Z",
          },
        },
      ],
    );
    await type(byLabel("Chart status"), "ACTIVE");
    expect(missed()).toBe("Saving drops 2 values in US size");
    await click("Save");
    expect(
      document
        .querySelector('s-banner[tone="critical"]')
        ?.getAttribute("heading"),
    ).toBe("Edits saved, but the chart is still a Draft");
    expect(missed()).toBeUndefined();
  });

  it("says Remove column for a country column, and announces the selection", async () => {
    await open([numbersInText()]);
    await act(async () => byLabel("Column 3 name").focus());
    const bar = document.querySelector('[role="status"]')!;
    expect(bar.getAttribute("aria-live")).toBe("polite");
    expect(bar.textContent).toContain("US size column selected");
    await click("Remove column");
    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Remove the US size column?");
    expect(dialog.textContent).toContain(
      "Saving removes US size from all 2 sizes, 2 (XS) to 6 (S). Shoppers won't see a US size column.",
    );
    await act(async () =>
      document.querySelector<HTMLElement>("dialog s-button[tone]")!.click(),
    );
    expect(missed()).toBeUndefined();
  });

  it("removes a size after the dialog names its values, and an empty one straight away", async () => {
    await open([stored()]);
    await act(async () => byLabel("Size 1").focus());
    expect(text()).toContain("Size XS selected");
    await click("Remove size");
    const dialog = document.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain("Remove size XS?");
    expect(dialog.textContent).toContain(
      "Saving removes XS's values: Bust 31–32.",
    );
    expect(dialog.textContent).toContain(
      "Until you save, Discard brings them back.",
    );
    await click("Cancel");
    expect(document.querySelector("dialog")).toBeNull();
    expect(byLabel("Size 1")).not.toBeNull();
    await click("Remove size");
    await act(async () =>
      document.querySelector<HTMLElement>("dialog s-button[tone]")!.click(),
    );
    expect(document.querySelector('[aria-label="Size 1"]')).toBeNull();
    expect(text()).not.toContain("selected");
    await act(async () => button("Add size").click());
    await act(async () => byLabel("Size 1").focus());
    await click("Remove size");
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.querySelector('[aria-label="Size 1"]')).toBeNull();
    await click("Discard");
    expect(byLabel("XS, Bust").value).toBe("31–32");
  });

  it("keeps a marked value on its own size when a size above it is removed", async () => {
    await open([stored()]);
    await act(async () => button("Add size").click());
    await type(byLabel("Size 2, Bust"), "33-");
    await click("Save");
    expect(byLabel("Size 2, Bust").getAttribute("aria-invalid")).toBe("true");
    await act(async () => byLabel("Size 1").focus());
    await click("Remove size");
    await act(async () =>
      document.querySelector<HTMLElement>("dialog s-button[tone]")!.click(),
    );
    await settle();
    expect(byLabel("Size 1, Bust").value).toBe("33-");
    expect(byLabel("Size 1, Bust").getAttribute("aria-invalid")).toBe("true");
    expect(text()).toContain("Size 1, Bust:");
    // Focus moves to the size that took its place, not the page.
    expect(document.activeElement).toBe(byLabel("Size 1"));
  });

  it("closes the dialog with its X or Escape and keeps the size", async () => {
    await open([stored()]);
    await act(async () => byLabel("Size 1").focus());
    await click("Remove size");
    await act(async () =>
      document
        .querySelector<HTMLElement>('dialog [aria-label="Close"]')!
        .click(),
    );
    expect(document.querySelector("dialog")).toBeNull();
    await click("Remove size");
    // Escape closes a modal dialog, which fires its close event.
    await act(async () =>
      document.querySelector("dialog")!.dispatchEvent(new Event("close")),
    );
    expect(document.querySelector("dialog")).toBeNull();
    expect(byLabel("XS, Bust").value).toBe("31–32");
  });

  it("removes a measurement after the dialog names the sizes it leaves", async () => {
    const { sent } = await open([stored()]);
    await act(async () => byLabel("Column 2 name").focus());
    expect(text()).toContain("Bust column selected");
    await click("Remove measurement");
    expect(document.querySelector("dialog")?.textContent).toContain(
      "Saving removes Bust from 1 size, 31–32 (XS). Shoppers won't see a Bust column.",
    );
    await act(async () =>
      document.querySelector<HTMLElement>("dialog s-button[tone]")!.click(),
    );
    expect(document.querySelector('[aria-label="XS, Bust"]')).toBeNull();
    await click("Save");
    const c = (sent[0].chart as ChartInput).content;
    expect(c.tables[0].columns).toEqual([{ id: "size", kind: "size" }]);
    expect(c.words).not.toHaveProperty(["t1.bust"]);
  });

  it("keeps the fit finder's only measurement, says why, and the chart still saves", async () => {
    const withFit = stored();
    const c = withFit.stored.chart.content;
    c.fit = {
      table: "t1",
      stretch: "none",
      ease: {},
      questions: [{ id: "qb", kind: "measure", col: "bust", optional: false }],
    };
    c.words["fit.qb"] = "Bust";
    const { sent } = await open([withFit]);
    await act(async () => byLabel("Column 2 name").focus());
    await click("Remove measurement");
    expect(document.querySelector("dialog")).toBeNull();
    const warn = document.querySelector('s-banner[tone="warning"]')!;
    expect(warn.getAttribute("heading")).toBe("Bust can't be removed");
    expect(warn.textContent).toBe(
      "It's the fit finder's only measurement. Add another one in Fit finder first.",
    );
    expect(warn.querySelector("a")?.getAttribute("href")).toBe(
      "/app/fit-finder",
    );
    expect(byLabel("XS, Bust").value).toBe("31–32");
    // Selecting again clears it.
    await act(async () => byLabel("Size 1").focus());
    await act(async () => byLabel("Column 2 name").focus());
    expect(missed()).toBeUndefined();
    await type(document.querySelector<HTMLInputElement>("#name")!, "Tops");
    await click("Save");
    expect(sent).toHaveLength(1);
    const saved = validateChart(sent[0].chart);
    expect(saved.content.fit?.questions).toEqual(c.fit.questions);
  });

  it("drops the banner when a remove takes its only marked value", async () => {
    await open([stored()]);
    await type(byLabel("XS, Bust"), "33-");
    await click("Save");
    expect(document.querySelector("s-banner")).not.toBeNull();
    await act(async () => byLabel("Column 2 name").focus());
    await click("Remove measurement");
    await act(async () =>
      document.querySelector<HTMLElement>("dialog s-button[tone]")!.click(),
    );
    await settle();
    expect(document.querySelector("s-banner")).toBeNull();
    expect(document.activeElement).toBe(byLabel("Column 1 name"));
  });

  // Each link out of the editor, and what shows it.
  const leaving: [string, string, () => Promise<void>][] = [
    ["Size charts", "/app/charts", async () => {}],
    ["Version history", "/app/charts/:id/history", async () => {}],
    [
      "Fit finder",
      "/app/fit-finder",
      async () => {
        await act(async () => byLabel("Column 2 name").focus());
        await click("Remove measurement");
      },
    ],
  ];
  const withFit = () => {
    const s = stored();
    const c = s.stored.chart.content;
    c.fit = {
      table: "t1",
      stretch: "none",
      ease: {},
      questions: [{ id: "qb", kind: "measure", col: "bust", optional: false }],
    };
    c.words["fit.qb"] = "Bust";
    return s;
  };
  const follow = async (label: string) => {
    const a = [...document.querySelectorAll<HTMLElement>("a")].find(
      (el) => el.textContent === label,
    )!;
    await act(async () => a.click());
    await settle();
  };

  it.each(leaving)(
    "asks before %s leaves unsaved edits, and leaves once confirmed",
    async (label, to, reveal) => {
      let confirm = () => {};
      bridge.saveBar.leaveConfirmation.mockImplementation(
        () => new Promise<void>((r) => (confirm = r)),
      );
      await open([withFit()]);
      await type(byLabel("XS, Bust"), "30–32");
      await reveal();
      await follow(label);
      expect(bridge.saveBar.leaveConfirmation).toHaveBeenCalledTimes(1);
      expect(byLabel("XS, Bust").value).toBe("30–32");
      expect(text()).not.toContain("Left for");
      await act(async () => confirm());
      await settle();
      expect(bridge.saveBar.hide).toHaveBeenCalledWith("chart-save-bar");
      expect(text()).toContain(`Left for ${to}`);
    },
  );

  it("keeps the edits when the merchant stays, and asks again on the next try", async () => {
    // Staying leaves the admin's promise unsettled.
    bridge.saveBar.leaveConfirmation.mockReturnValue(new Promise(() => {}));
    await open([stored()]);
    await type(byLabel("XS, Bust"), "30–32");
    await follow("Size charts");
    await follow("Size charts");
    expect(bridge.saveBar.leaveConfirmation).toHaveBeenCalledTimes(2);
    expect(byLabel("XS, Bust").value).toBe("30–32");
    expect(text()).not.toContain("Left for");
  });

  it("says so when the admin can't check before leaving, and keeps the edits", async () => {
    bridge.saveBar.leaveConfirmation.mockRejectedValue(new Error("no admin"));
    await open([stored()]);
    await type(byLabel("XS, Bust"), "30–32");
    await follow("Size charts");
    expect(bridge.toast.show).toHaveBeenCalledWith(
      "Couldn't leave this page. Save or discard your edits, then try again.",
      { isError: true },
    );
    expect(byLabel("XS, Bust").value).toBe("30–32");
    expect(text()).not.toContain("Left for");
    // Trying again asks again.
    await follow("Size charts");
    expect(bridge.saveBar.leaveConfirmation).toHaveBeenCalledTimes(2);
  });

  it("asks before Back leaves unsaved edits, and goes back once confirmed", async () => {
    let confirm = () => {};
    bridge.saveBar.leaveConfirmation.mockImplementation(
      () => new Promise<void>((r) => (confirm = r)),
    );
    await open([stored()], [], ["/app/charts", "/app/charts/42"]);
    await type(byLabel("XS, Bust"), "30–32");
    await back();
    expect(bridge.saveBar.leaveConfirmation).toHaveBeenCalledTimes(1);
    expect(at.pathname).toBe("/app/charts/42");
    expect(byLabel("XS, Bust").value).toBe("30–32");
    await act(async () => confirm());
    await settle();
    expect(bridge.saveBar.hide).toHaveBeenCalledWith("chart-save-bar");
    expect(text()).toContain("Left for /app/charts");
  });

  it("leaves without asking when nothing is unsaved", async () => {
    await open([stored()]);
    await follow("Size charts");
    expect(bridge.saveBar.leaveConfirmation).not.toHaveBeenCalled();
    expect(text()).toContain("Left for /app/charts");
  });
});
