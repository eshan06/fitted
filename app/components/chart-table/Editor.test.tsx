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
const { default: ChartEditor, shouldRevalidate } =
  await import("../../routes/app.charts.$id");

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

const IMG = {
  id: "gid://shopify/MediaImage/9",
  url: "https://cdn.shopify.com/s/files/1/files/measure-tops.png?v=1",
  sig: "sig-9",
};
let uploads: { status: number; body: unknown }[] = [];
// While set, a drawing's upload waits for it.
let hold: Promise<unknown> | undefined;
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
      shouldRevalidate,
      loader,
      action: async ({ request }) => {
        // A drawing's upload answers from `uploads`, in turn.
        if (request.headers.get("content-type")?.includes("multipart")) {
          const file = (await request.formData()).get("file") as File;
          sent.push({ upload: file.name });
          await hold;
          const u = uploads.shift() ?? { status: 200, body: { image: IMG } };
          return Response.json(u.body, { status: u.status });
        }
        // A let-go upload's discard.
        if (request.method === "DELETE") {
          const f = await request.formData();
          sent.push({ discard: f.get("id"), sig: f.get("sig") });
          return Response.json({ discarded: f.get("id") });
        }
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

  it("links a stored step's finding to its field on the How to measure tab", async () => {
    const b = broken({
      "content.words.m.m1.name": "Too long",
      "content.words.tips": "Too long",
    });
    b.stored.raw.content.measure.steps = ["m1"];
    b.stored.raw.content.words["m.m1.name"] = "Bust";
    await open([b]);
    expect(text()).toContain("Step 1: Too long");
    const link = [...document.querySelectorAll("s-banner a")].find(
      (a) => a.textContent === "Step 1",
    ) as HTMLAnchorElement;
    await act(async () => link.click());
    await settle();
    expect(document.activeElement).toBe(byLabel("Step 1 name"));
    expect(byLabel("Step 1 name").value).toBe("Bust");
    // The tips' finding opens Fit tips, and a cell's goes back to the table.
    const follow = async (where: string) => {
      const a = [...document.querySelectorAll("s-banner a")].find(
        (x) => x.textContent === where,
      ) as HTMLAnchorElement;
      await act(async () => a.click());
      await settle();
    };
    await follow("Fit tips");
    expect(document.activeElement?.id).toBe("tips");
    await follow("XS, Bust");
    expect(document.activeElement).toBe(byLabel("XS, Bust"));
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

describe("table tools", () => {
  // Women's tops with three sizes and a Fit text column.
  const withFit = () => {
    const s = stored();
    const c = s.stored.chart.content;
    c.tables[0].columns.push({ id: "fit", kind: "text" });
    c.tables[0].rows.push({ id: "s", cells: {} }, { id: "m", cells: {} });
    Object.assign(c.words, {
      "t1.fit": "Fit",
      "t1.s.size": "S",
      "t1.m.size": "M",
      "t1.xs.fit": "Relaxed",
      "t1.s.fit": "Regular",
    });
    return s;
  };
  const shiftTo = async (from: string, key: "ArrowDown" | "ArrowUp") => {
    await act(async () => byLabel(from).focus());
    await act(async () =>
      byLabel(from).dispatchEvent(
        new KeyboardEvent("keydown", { key, shiftKey: true, bubbles: true }),
      ),
    );
  };
  const status = () => document.querySelector('[role="status"]')!.textContent;
  const toolbar = (label: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="toolbar"] button',
      ),
    ].find((b) => b.textContent === label)!;

  it("merges cells after the dialog names the values it removes, then wraps and unmerges", async () => {
    const { sent } = await open([withFit()]);
    await act(async () => byLabel("XS, Fit").focus());
    // One cell can't be merged.
    expect(toolbar("Merge cells").disabled).toBe(true);
    await shiftTo("XS, Fit", "ArrowDown");
    await shiftTo("S, Fit", "ArrowDown");
    expect(document.activeElement).toBe(byLabel("M, Fit"));
    expect(status()).toContain("3 cells selected in Fit, XS to M");
    expect(toolbar("Merge cells").disabled).toBe(false);
    await act(async () => toolbar("Merge cells").click());
    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Merge 3 cells in Fit?");
    expect(dialog.textContent).toContain(
      "The merged cell keeps XS's value, Relaxed. Saving removes the other 1: Regular (S).",
    );
    expect(dialog.textContent).toContain(
      "Until you save, Discard brings them back.",
    );
    await act(async () =>
      document.querySelector<HTMLElement>("dialog s-button[tone]")!.click(),
    );
    await settle();
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.querySelector('[aria-label="S, Fit"]')).toBeNull();
    expect(byLabel("XS, Fit").closest("td")!.rowSpan).toBe(3);
    expect(status()).toContain("Fit column, XS to M merged");
    const wrap = document.querySelector<HTMLInputElement>(
      '[role="status"] input[type="checkbox"]',
    )!;
    await act(async () => wrap.click());
    expect(toolbar("Wrap text").getAttribute("aria-pressed")).toBe("true");
    await click("Save");
    const t = (sent[0].chart as ChartInput).content;
    expect(t.tables[0].merges).toEqual([
      { row: "xs", col: "fit", rows: 3, cols: 1 },
    ]);
    expect(t.tables[0].wrap).toEqual(["fit"]);
    expect(t.words).not.toHaveProperty(["t1.s.fit"]);
    await click("Unmerge cells");
    expect(byLabel("S, Fit").value).toBe("");
    expect(byLabel("XS, Fit").closest("td")!.rowSpan).toBe(1);
  });

  it("merges empty cells straight away, and Shift-click selects up a column", async () => {
    await open([withFit()]);
    await act(async () => byLabel("M, Fit").focus());
    await act(async () => {
      byLabel("S, Fit").dispatchEvent(
        new MouseEvent("mousedown", { shiftKey: true, bubbles: true }),
      );
      byLabel("S, Fit").focus();
    });
    expect(status()).toContain("2 cells selected in Fit, S to M");
    await click("Merge cells");
    expect(document.querySelector("dialog")).toBeNull();
    expect(byLabel("S, Fit").value).toBe("Regular");
    expect(document.querySelector('[aria-label="M, Fit"]')).toBeNull();
    // A merged cell can't be merged again.
    await shiftTo("XS, Fit", "ArrowDown");
    expect(status()).toContain("2 cells selected in Fit, XS to S");
    expect(toolbar("Merge cells").disabled).toBe(true);
    await click("Discard");
    expect(byLabel("M, Fit")).not.toBeNull();
  });

  it("rounds, sets a measurement's unit and keeps it unconverted", async () => {
    const { sent } = await open([stored()]);
    const round = document.querySelector<HTMLSelectElement>(
      '[role="toolbar"] select',
    )!;
    expect(round.closest("label")!.textContent).toContain("Round to");
    await type(round, "1");
    await act(async () => byLabel("Column 2 name").focus());
    expect(status()).toContain("Bust column selected");
    // Wrap text follows the selected column.
    await act(async () => toolbar("Wrap text").click());
    expect(toolbar("Wrap text").getAttribute("aria-pressed")).toBe("true");
    const unit = document.querySelector<HTMLSelectElement>(
      '[role="status"] select',
    )!;
    expect(unit.value).toBe("in");
    await type(unit, "cm");
    await act(async () =>
      document
        .querySelector<HTMLInputElement>(
          '[role="status"] input[type="checkbox"]',
        )!
        .click(),
    );
    await click("Save");
    const c = (sent[0].chart as ChartInput).content;
    expect(c.roundTo).toBe(1);
    expect(c.unit).toBe("in");
    expect(c.tables[0].wrap).toEqual(["bust"]);
    expect(c.tables[0].columns[1]).toEqual({
      id: "bust",
      kind: "measure",
      unit: "cm",
      convert: false,
    });
  });

  it("draws a stored merge across columns, and keeps every size reachable under a size merge", async () => {
    const s = withFit();
    const t = s.stored.chart.content.tables[0];
    t.merges = [
      { row: "xs", col: "bust", rows: 1, cols: 2 },
      { row: "s", col: "size", rows: 2, cols: 1 },
    ];
    await open([s]);
    expect(byLabel("XS, Bust").closest("td")!.colSpan).toBe(2);
    expect(document.querySelector('[aria-label="XS, Fit"]')).toBeNull();
    // Sizes under a size merge stay drawn, so each can be named or removed.
    expect(byLabel("Size 3").value).toBe("M");
    await act(async () => byLabel("Size 3").focus());
    expect(status()).toContain("Size M selected");
  });
});

describe("Paste whole chart", () => {
  const dialog = () => document.querySelector("dialog");
  const area = () =>
    dialog()!.querySelector("textarea") as unknown as HTMLInputElement;
  const tool = (label: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="toolbar"] button',
      ),
    ].find((b) => b.textContent === label)!;
  const chartSent = (b: Record<string, unknown>) =>
    validateChart(b.chart).content;

  it("opens from the toolbar, says what it found, and fills the table with the unreadable cells marked", async () => {
    const s = stored();
    s.stored.chart.content.words["t1.note"] = "Between sizes? Size up.";
    const { sent } = await open([s]);
    await act(async () => tool("Paste whole chart").click());
    expect(dialog()!.textContent).toContain("Paste a whole chart");
    expect(dialog()!.textContent).toContain(
      "Sizes go in the first column and measurements in the rest.",
    );
    expect(button("Fill the table").hasAttribute("disabled")).toBe(true);
    expect(document.activeElement).toBe(area());
    // No table: the box is marked, and Fill stays greyed out.
    await type(area(), "Our autumn tops run a little small.\nSize up.");
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe(
      "Fitted couldn't find a table in this. Copy whole rows and columns from a spreadsheet, with sizes in the first column.",
    );
    expect(area().getAttribute("aria-invalid")).toBe("true");
    expect(button("Fill the table").hasAttribute("disabled")).toBe(true);
    // Text that looks like markup stays text.
    const markup = "<img src=x onerror=alert(1)>";
    await type(
      area(),
      `Size\tBust\tWaist\n${markup}\t31–32\t24\nM\tabout 35\t28`,
    );
    expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe(
      "Found 2 sizes and 2 measurements: Bust and WaistFilling replaces what's in the table now. Until you save, Discard brings it back.",
    );
    await click("Replace the table");
    expect(dialog()).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(byLabel("Size 1").value).toBe(markup);
    expect(document.activeElement).toBe(byLabel("Size 1"));
    expect(
      document
        .querySelector('s-banner[tone="critical"]')!
        .getAttribute("heading"),
    ).toBe("Fix 1 cell to save");
    expect(byLabel("M, Bust").getAttribute("aria-invalid")).toBe("true");
    await type(byLabel("M, Bust"), "35");
    await click("Save");
    const c = chartSent(sent[0]);
    expect(c.tables[0].rows.map((r) => r.cells)).toEqual([
      { bust: [31, 32], c1: [24] },
      { bust: [35], c1: [28] },
    ]);
    expect(c.words["t1.note"]).toBe("Between sizes? Size up.");
  });

  it("closes without changing the table, and Discard brings the old one back", async () => {
    await open([stored()]);
    await act(async () => tool("Paste whole chart").click());
    await type(area(), "Size\tHips\nL\t40");
    await click("Cancel");
    expect(dialog()).toBeNull();
    expect(byLabel("Size 1").value).toBe("XS");
    await act(async () => tool("Paste whole chart").click());
    expect(area().value).toBe("");
    await type(area(), "Size\tHips\nL\t40");
    await click("Replace the table");
    expect(byLabel("Size 1").value).toBe("L");
    expect(byLabel("L, Hips").value).toBe("40");
    await click("Discard");
    expect(byLabel("XS, Bust").value).toBe("31–32");
  });

  it("fills a blank chart from its own button", async () => {
    const { sent } = await open(
      [{ mode: "new", handle: "c-abc" }],
      [],
      "/app/charts/new",
    );
    expect(text()).toContain(
      "Paste a whole table from a spreadsheet or supplier sheet and Fitted fills in the sizes and measurements.",
    );
    await click("Paste whole chart");
    await type(area(), "Size\tUS\tUK\tWaist (cm)\nS\t4\t8\t66");
    await click("Replace the table");
    // The chart's name isn't the paste's to mark.
    expect(document.querySelector('s-banner[tone="critical"]')).toBeNull();
    await type(document.querySelector<HTMLInputElement>("#name")!, "Jeans");
    await click("Save");
    const c = chartSent(sent[0]);
    expect(c.tables[0].columns.slice(1)).toEqual([
      { id: "c1", kind: "country", country: "US" },
      { id: "c2", kind: "country", country: "UK" },
      { id: "c3", kind: "measure", unit: "cm", convert: true },
    ]);
    expect(c.words["t1.c3"]).toBe("Waist");
  });
});

describe("Country sizes", () => {
  const countries = () =>
    [
      ...document.querySelectorAll<HTMLSelectElement>(
        '[role="toolbar"] select',
      ),
    ].find((s) =>
      s.closest("label")!.textContent!.startsWith("Country sizes"),
    )!;
  const option = (label: string) =>
    [...countries().options].find((o) => o.textContent === label)!;
  const chartSent = (b: Record<string, unknown>) =>
    validateChart(b.chart).content;

  it("adds UK, EU and AU columns, and takes them out for US only once they're empty", async () => {
    const s = stored();
    const t = s.stored.chart.content.tables[0];
    t.columns.splice(1, 0, { id: "us", kind: "country", country: "US" });
    s.stored.chart.content.words["t1.us"] = "US size";
    const { sent } = await open([s]);
    // After Round to, as drawn.
    expect(
      [...document.querySelectorAll('[role="toolbar"] label')].map(
        (l) => l.firstChild!.textContent,
      ),
    ).toEqual(["Round to", "Country sizes"]);
    expect(countries().value).toBe("us");
    expect(text()).not.toContain("Shoppers see one country's sizes");
    await type(countries(), "all");
    expect(
      [2, 3, 4, 5, 6].map((n) => byLabel(`Column ${n} name`).value),
    ).toEqual(["US size", "UK size", "EU size", "AU size", "Bust"]);
    expect(text()).toContain(
      "Shoppers see one country's sizes at a time, with a US, UK, EU, AU switch.",
    );
    expect(countries().value).toBe("all");
    // A UK size would be lost, so US only is greyed out until it's cleared.
    await type(byLabel("XS, UK size"), "4–6");
    expect(option("US only").disabled).toBe(true);
    await click("Save");
    expect(chartSent(sent[0]).words["t1.xs.c1"]).toBe("4–6");
    await type(byLabel("XS, UK size"), "");
    expect(option("US only").disabled).toBe(false);
    await type(countries(), "us");
    expect(byLabel("Column 2 name").value).toBe("US size");
    expect(byLabel("Column 3 name").value).toBe("Bust");
    expect(countries().value).toBe("us");
    expect(text()).not.toContain("Shoppers see one country's sizes");
  });
});

describe("How to measure and Fit tips tabs", () => {
  const saved = (b: Record<string, unknown>) =>
    validateChart(b.chart as ChartInput);
  const tab = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".tab")].find(
      (b) => b.textContent === label,
    )!;
  const openTab = async (label: string) => {
    await act(async () => tab(label).click());
  };
  // Picks a file in the drawing's hidden file input.
  const pick = async (name: string, bytes: number[]) => {
    const el = byLabel("Measuring drawing file");
    const file = new File([new Uint8Array(bytes)], name);
    Object.defineProperty(el, "files", { value: [file], configurable: true });
    await act(async () =>
      el.dispatchEvent(new Event("change", { bubbles: true })),
    );
    await settle();
  };
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0];
  afterEach(() => {
    uploads = [];
    hold = undefined;
  });

  it("switches tabs, adds and names steps, removes one, and saves them", async () => {
    const { sent } = await open([stored()]);
    expect(
      [...document.querySelectorAll(".tab")].map((b) => b.textContent),
    ).toEqual(["Size table", "How to measure", "Fit tips", "Media"]);
    expect(tab("Size table").getAttribute("aria-pressed")).toBe("true");
    await openTab("How to measure");
    expect(tab("How to measure").getAttribute("aria-pressed")).toBe("true");
    expect(byLabel("XS, Bust")).toBeNull();
    expect(text()).toContain("No steps yet");
    expect(text()).toContain(
      "Tell shoppers where to hold the tape, one step per measurement.",
    );
    expect(text()).toContain("Add a measuring drawing");
    expect(text()).toContain(
      "PNG or JPG. Number its lines to match the steps.",
    );
    await click("Add step");
    await click("Add step");
    expect(document.activeElement).toBe(byLabel("Step 2 name"));
    expect(text()).toContain(
      "Step 1 is line 1 on the drawing. Up to 20 steps.",
    );
    await type(byLabel("Step 1 name"), "Bust");
    await type(byLabel("Step 1, how to measure"), "Around the fullest part.");
    await type(byLabel("Step 2 name"), "Waist");
    await act(async () => byLabel("Remove step 1").click());
    expect(byLabel("Step 1 name").value).toBe("Waist");
    await click("Save");
    const c = saved(sent[0]).content;
    expect(c.measure.steps).toHaveLength(1);
    expect(c.words[`m.${c.measure.steps[0]}.name`]).toBe("Waist");
    expect(Object.keys(c.words).filter((k) => k.startsWith("m."))).toHaveLength(
      1,
    );
  });

  it("counts the fit tips as they're typed and saves them", async () => {
    const { sent } = await open([stored()]);
    await openTab("Fit tips");
    // A textarea; `type` sets its value the same way.
    const tips = document.getElementById("tips") as HTMLInputElement;
    expect(tips.placeholder).toBe(
      "For example, Runs small through the shoulders. Size up if you're between sizes.",
    );
    expect(tips.maxLength).toBe(2000);
    expect(text()).toContain("Shoppers see these under the size table.");
    expect(text()).toContain("0 of 2,000 characters");
    await type(tips, "Runs small.\nSize up.");
    expect(text()).toContain("20 of 2,000 characters");
    await click("Save");
    expect(saved(sent[0]).content.words.tips).toBe("Runs small.\nSize up.");
  });

  it("uploads a drawing, shows it from Shopify, and saves it with the chart", async () => {
    const { sent } = await open([stored()]);
    await openTab("How to measure");
    await pick("measure-tops.png", PNG);
    expect(sent).toEqual([{ upload: "measure-tops.png" }]);
    const img = document.querySelector<HTMLImageElement>(".drawing img")!;
    expect(img.src).toBe(IMG.url);
    expect(img.alt).toBe("Measuring drawing");
    expect(text()).toContain("measure-tops.png");
    expect(button("Replace")).toBeTruthy();
    await click("Save");
    expect(saved(sent[1]).measureImage).toBe(IMG.id);
  });

  it("refuses a GIF or WebP before sending it, as not a PNG or JPG", async () => {
    const { sent } = await open([stored()]);
    await openTab("How to measure");
    await pick("measure-tops.webp", [0x52, 0x49, 0x46, 0x46]);
    expect(sent).toEqual([]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "measure-tops.webp isn't a PNG or JPGSave it as one and add it again.",
    );
    await pick("measure-tops.png", [0x47, 0x49, 0x46, 0x38]);
    expect(text()).toContain("measure-tops.png isn't a PNG or JPG");
    expect(sent).toEqual([]);
    // Try again picks another file.
    const picker = vi.spyOn(byLabel("Measuring drawing file"), "click");
    await click("Try again");
    expect(picker).toHaveBeenCalledOnce();
  });

  it("shows the upload's progress until Shopify answers, one upload at a time", async () => {
    let answer!: (v?: unknown) => void;
    hold = new Promise((r) => (answer = r));
    const { sent } = await open([stored()]);
    await type(byLabel("XS, Bust"), "30–32");
    await openTab("How to measure");
    await pick("measure-tops.png", PNG);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Uploading measure-tops.png",
    );
    // A save would remount the editor and lose the upload.
    expect(button("Save").hasAttribute("disabled")).toBe(true);
    // The box under the size table can't start a second one.
    await pick("other.png", PNG);
    expect(sent).toEqual([{ upload: "measure-tops.png" }]);
    await act(async () => answer());
    await settle();
    expect(text()).not.toContain("Uploading");
    expect(document.querySelector(".drawing img")).not.toBeNull();
  });

  it("says an image over Shopify's 20 MB didn't upload, without sending it", async () => {
    const { sent } = await open([stored()]);
    await openTab("How to measure");
    const el = byLabel("Measuring drawing file");
    const file = new File([new Uint8Array(PNG)], "huge.png");
    Object.defineProperty(file, "size", { value: 20 * 1024 * 1024 + 1 });
    Object.defineProperty(el, "files", { value: [file], configurable: true });
    await act(async () =>
      el.dispatchEvent(new Event("change", { bubbles: true })),
    );
    await settle();
    expect(text()).toContain("huge.png didn't upload");
    expect(sent).toEqual([]);
  });

  it("adds the drawing from the box under the size table", async () => {
    await open([stored()]);
    expect(text()).toContain("PNG or JPG, shown in the How to measure tab");
    const picker = vi.spyOn(byLabel("Measuring drawing file"), "click");
    await click(
      "How-to-measure imagePNG or JPG, shown in the How to measure tab",
    );
    expect(picker).toHaveBeenCalledOnce();
    expect(tab("How to measure").getAttribute("aria-pressed")).toBe("true");
    await pick("measure-tops.png", PNG);
    expect(document.querySelector(".drawing img")).not.toBeNull();
  });

  it("says a drawing didn't upload, keeps the chart without one, and tries again", async () => {
    uploads = [
      { status: 502, body: { error: { code: "upload", message: "x" } } },
    ];
    const { sent } = await open([stored()]);
    await openTab("How to measure");
    await pick("measure-tops.png", PNG);
    expect(text()).toContain("measure-tops.png didn't upload");
    expect(text()).toContain(
      "Shopify didn't answer, so the chart has no drawing yet.",
    );
    // Nothing changed, so there's nothing to save.
    expect(document.querySelector('[data-testid="save-bar"]')).toBeNull();
    await click("Try again");
    expect(sent).toEqual([
      { upload: "measure-tops.png" },
      { upload: "measure-tops.png" },
    ]);
    expect(document.querySelector(".drawing img")).not.toBeNull();
  });

  it("shows a stored drawing by its name, and Remove saves the chart without it", async () => {
    const s = stored();
    const withImage = {
      ...s,
      stored: {
        ...s.stored,
        chart: {
          ...s.stored.chart,
          measureImage: "gid://shopify/MediaImage/3",
        },
        measureImageUrl:
          "https://cdn.shopify.com/s/files/1/files/tops%20chart.jpg?v=2",
      },
    };
    const { sent } = await open([withImage]);
    await openTab("How to measure");
    expect(text()).toContain("tops chart.jpg");
    await click("Remove");
    expect(text()).toContain("Add a measuring drawing");
    await click("Save");
    expect(saved(sent[0]).measureImage).toBeUndefined();
  });

  it("says a file the server refuses isn't a PNG or JPG", async () => {
    uploads = [
      {
        status: 422,
        body: {
          fieldErrors: { measureImage: "Use a PNG or JPG up to 20 MB." },
        },
      },
    ];
    await open([stored()]);
    await openTab("How to measure");
    await pick("measure-tops.png", PNG);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "measure-tops.png isn't a PNG or JPG",
    );
  });

  // Each upload answers the next MediaImage id, signed.
  const img = (n: number) => ({
    status: 200,
    body: {
      image: {
        id: `gid://shopify/MediaImage/${n}`,
        url: IMG.url,
        sig: `sig-${n}`,
      },
    },
  });
  const discards = (sent: Record<string, unknown>[]) =>
    sent.filter((b) => "discard" in b);

  // The stored chart holding MediaImage `n`.
  const withImage = (n: number, updatedAt?: string) => {
    const s = stored(updatedAt);
    const measureImage = `gid://shopify/MediaImage/${n}`;
    return {
      ...s,
      stored: {
        ...s.stored,
        chart: { ...s.stored.chart, measureImage },
        measureImageUrl: `https://cdn.shopify.com/s/files/1/files/stored-${n}.png`,
      },
    };
  };

  it("deletes an upload replaced, removed or discarded before a save, never a stored one", async () => {
    const { sent } = await open([withImage(4)]);
    await openTab("How to measure");
    uploads = [img(10), img(11), img(12)];
    // Replacing the stored drawing leaves it alone.
    await pick("a.png", PNG);
    expect(discards(sent)).toEqual([]);
    await pick("b.png", PNG);
    expect(discards(sent)).toEqual([
      { discard: "gid://shopify/MediaImage/10", sig: "sig-10" },
    ]);
    await click("Remove");
    await pick("c.png", PNG);
    await click("Discard");
    expect(discards(sent)).toEqual([
      { discard: "gid://shopify/MediaImage/10", sig: "sig-10" },
      { discard: "gid://shopify/MediaImage/11", sig: "sig-11" },
      { discard: "gid://shopify/MediaImage/12", sig: "sig-12" },
    ]);
    expect(text()).toContain("stored-4.png");
  });

  it("keeps a saved upload, and deletes one that answers after Discard", async () => {
    // The save reloads the chart with the drawing, which remounts the editor.
    const { sent } = await open([
      stored(),
      withImage(9, "2026-11-19T10:05:00Z"),
    ]);
    await openTab("How to measure");
    await pick("measure-tops.png", PNG);
    await click("Save");
    expect(saved(sent[1]).measureImage).toBe(IMG.id);
    await openTab("How to measure");
    await click("Remove");
    let answer!: (v?: unknown) => void;
    hold = new Promise((r) => (answer = r));
    uploads = [img(10)];
    await pick("late.png", PNG);
    await click("Discard");
    expect(text()).not.toContain("Uploading");
    await act(async () => answer());
    await settle();
    expect(discards(sent)).toEqual([
      { discard: "gid://shopify/MediaImage/10", sig: "sig-10" },
    ]);
  });

  it("deletes an unsaved upload when the merchant leaves the editor", async () => {
    const { sent } = await open(
      [stored()],
      [],
      ["/app/charts", "/app/charts/42"],
    );
    await openTab("How to measure");
    await pick("measure-tops.png", PNG);
    await back();
    expect(text()).toContain("Left for /app/charts");
    expect(discards(sent)).toEqual([{ discard: IMG.id, sig: IMG.sig }]);
  });
});

describe("More tables", () => {
  // The Editor board's two tables: body and garment measurements.
  const twoTables = (fit = false) => {
    const s = stored();
    const c = s.stored.chart.content;
    c.tables.push({
      id: "t2",
      columns: [
        { id: "sz", kind: "size" },
        { id: "len", kind: "measure", convert: true },
        { id: "slv", kind: "measure", convert: true },
      ],
      rows: [{ id: "r1", cells: { len: [24], slv: [23] } }],
    });
    Object.assign(c.words, {
      "t1.title": "Body measurements",
      "t2.title": "Garment measurements",
      "t2.sz": "Size",
      "t2.len": "Length",
      "t2.slv": "Sleeve",
      "t2.r1.sz": "XS",
    });
    if (fit) {
      c.fit = {
        table: "t2",
        stretch: "none",
        ease: {},
        questions: [{ id: "ql", kind: "measure", col: "len", optional: false }],
      };
      c.words["fit.ql"] = "Length";
    }
    return s;
  };
  const tables = () =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Tables in this chart"] button',
      ),
    ].map(
      (b) =>
        `${b.textContent}${b.getAttribute("aria-pressed") === "true" ? " *" : ""}`,
    );

  it("lists table 2 under the first, edits it with the table tools, and saves both", async () => {
    const { sent } = await open([twoTables()]);
    const row = document.querySelector(".tablerow")!;
    expect(row.textContent).toContain("Table 2: Garment measurements");
    expect(row.textContent).toContain(
      "Length and sleeve, shown under its own heading in the same chart",
    );
    expect(text()).not.toContain("A chart holds up to 4 tables");
    await click("Edit table");
    expect(tables()).toEqual([
      "1. Body measurements",
      "2. Garment measurements *",
    ]);
    expect(document.querySelector(".tablerow")).toBeNull();
    expect(text()).toContain(
      "A chart holds up to 4 tables. Shoppers see them in order, each under its heading.",
    );
    expect(byLabel("XS, Bust")).toBeNull();
    await type(byLabel("XS, Length"), "24.5");
    await type(
      document.querySelector<HTMLInputElement>("#t2-sub")!,
      "Measured flat, across the garment.",
    );
    await click("Add size");
    await type(byLabel("Size 2"), "S");
    await type(byLabel("S, Length"), "25");
    await click("1. Body measurements");
    expect(byLabel("XS, Bust").value).toBe("31–32");
    await click("Save");
    const c = validateChart(sent[0].chart).content;
    expect(c.tables.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(c.tables[1].rows.map((r) => r.cells)).toEqual([
      { len: [24.5], slv: [23] },
      { len: [25] },
    ]);
    expect(c.words["t2.sub"]).toBe("Measured flat, across the garment.");
  });

  it("marks a bad value in table 2 and links the banner to it from the first table", async () => {
    const { sent } = await open([twoTables()]);
    await click("Edit table");
    await type(byLabel("XS, Length"), "0");
    await click("1. Body measurements");
    await click("Save");
    expect(sent).toEqual([]);
    const banner = document.querySelector('s-banner[tone="critical"]')!;
    expect(banner.getAttribute("heading")).toBe("Fix 1 cell to save");
    expect(banner.textContent).toContain("XS, Length is 0");
    // Table 1's list shows only its own cells.
    expect(document.querySelector(".list.err")).toBeNull();
    await act(async () => banner.querySelector("a")!.click());
    await settle();
    expect(tables()).toContain("2. Garment measurements *");
    expect(document.activeElement).toBe(byLabel("XS, Length"));
    expect(byLabel("XS, Length").getAttribute("aria-invalid")).toBe("true");
    expect(text()).toContain(
      "XS, Length: Use a number above 0, or clear the cell.",
    );
  });

  it("opens a stored table 2 with its bad values marked and its dropped numbers warned", async () => {
    const s = twoTables();
    const raw = JSON.parse(JSON.stringify(s.stored.chart));
    raw.content.tables[1].rows[0].cells = { len: [25, 24], sz: [6] };
    const { id, status, updatedAt } = s.stored;
    await open([
      {
        mode: "edit",
        stored: {
          id,
          status,
          updatedAt,
          raw,
          fieldErrors: {
            "content.tables.1.rows.0.cells.len": "Use a range from low to high",
            "content.tables.1.rows.0.cells.sz": "Not a measurement column",
          },
        },
      },
    ]);
    expect(
      document
        .querySelector('s-banner[tone="critical"]')
        ?.getAttribute("heading"),
    ).toBe("Fix 1 value to save this chart");
    expect(text()).toContain("XS, Length runs from high to low");
    expect(missed()).toBe("Saving drops 1 value in Size");
    await click("Edit table");
    expect(byLabel("XS, Length").value).toBe("25–24");
    expect(byLabel("XS, Length").getAttribute("aria-invalid")).toBe("true");
    expect(byLabel("Size 1").className).toContain("drop");
  });

  it("keeps table 2's fit finder measurement, and never removes the fit finder's table", async () => {
    const { sent } = await open([twoTables(true)]);
    await click("Edit table");
    await act(async () => byLabel("Column 2 name").focus());
    await click("Remove measurement");
    expect(missed()).toBe("Length can't be removed");
    expect((button("Remove table") as HTMLButtonElement).disabled).toBe(true);
    await type(document.querySelector<HTMLInputElement>("#name")!, "Tops");
    await click("Save");
    expect(validateChart(sent[0].chart).content.fit?.table).toBe("t2");
  });

  it("fills table 2 from a paste, marks what it can't read there, and keeps table 1", async () => {
    const { sent } = await open([twoTables()]);
    await click("Edit table");
    await click("Paste whole chart");
    await type(
      document.querySelector<HTMLInputElement>("dialog textarea")!,
      "Size\tLength\nXS\t26\nS\tlong",
    );
    await click("Replace the table");
    expect(tables()).toContain("2. Garment measurements *");
    expect(byLabel("XS, Length").value).toBe("26");
    expect(byLabel("S, Length").getAttribute("aria-invalid")).toBe("true");
    await type(byLabel("S, Length"), "27");
    await click("Save");
    const c = validateChart(sent[0].chart).content;
    expect(c.tables[0].rows[0].cells).toEqual({ bust: [31, 32] });
    expect(c.tables[1].rows.map((r) => r.cells)).toEqual([
      { len: [26] },
      { len: [27] },
    ]);
  });

  it("moves table 2's findings with a removed size, and keeps its switch once it has none", async () => {
    const s = twoTables();
    s.stored.chart.content.tables[1].rows.push({ id: "r2", cells: {} });
    s.stored.chart.content.words["t2.r2.sz"] = "S";
    await open([s]);
    await click("Edit table");
    await type(byLabel("S, Length"), "0");
    await click("Save");
    expect(byLabel("S, Length").getAttribute("aria-invalid")).toBe("true");
    await act(async () => byLabel("Size 1").focus());
    await click("Remove size");
    await act(async () =>
      document.querySelector<HTMLElement>("dialog s-button[tone]")!.click(),
    );
    // S moved up to the first size, and its finding with it.
    expect(byLabel("S, Length").getAttribute("aria-invalid")).toBe("true");
    expect(byLabel("Size 1").value).toBe("S");
    await act(async () => byLabel("Size 1").focus());
    await click("Remove size");
    await act(async () =>
      document.querySelector<HTMLElement>("dialog s-button[tone]")!.click(),
    );
    expect(document.querySelector('s-banner[tone="critical"]')).toBeNull();
    expect(tables()).toContain("2. Garment measurements *");
    await click("1. Body measurements");
    expect(byLabel("XS, Bust").value).toBe("31–32");
  });

  it("stays on table 2 after a banner link to another tab", async () => {
    await open(
      [twoTables()],
      [
        {
          status: 422,
          body: { fieldErrors: { "content.words.tips": "Too long" } },
        },
      ],
    );
    await click("Edit table");
    await type(byLabel("XS, Length"), "30");
    await click("Save");
    const link = document.querySelector<HTMLElement>(
      's-banner[tone="critical"] a[href="#tips"]',
    )!;
    await act(async () => link.click());
    await settle();
    expect(document.activeElement?.id).toBe("tips");
    await click("Size table");
    expect(tables()).toContain("2. Garment measurements *");
  });

  it("clones and adds tables up to 4, removes one, and discards back to the stored two", async () => {
    const { sent } = await open([twoTables()]);
    await click("Clone table");
    expect(tables()).toEqual([
      "1. Body measurements",
      "2. Garment measurements",
      "3. Garment measurements *",
    ]);
    expect(byLabel("XS, Length").value).toBe("24");
    await click("Add another table");
    expect(tables()).toEqual([
      "1. Body measurements",
      "2. Garment measurements",
      "3. Garment measurements",
      "4. Table 4 *",
    ]);
    expect(byLabel("Size 1").value).toBe("XS");
    for (const b of ["Add another table", "Clone table"])
      expect((button(b) as HTMLButtonElement).disabled).toBe(true);
    await click("Remove table");
    expect(tables()).toContain("3. Garment measurements *");
    expect((button("Add another table") as HTMLButtonElement).disabled).toBe(
      false,
    );
    await click("Discard");
    expect(document.querySelectorAll(".tablerow")).toHaveLength(0);
    expect(tables()).toContain("2. Garment measurements *");
    await click("Remove table");
    await click("Save");
    expect(validateChart(sent[0].chart).content.tables).toHaveLength(1);
  });

  it("takes a removed table's findings off the banner, and caps its heading at 500 characters", async () => {
    await open([twoTables()]);
    await click("Edit table");
    for (const id of ["#t2-title", "#t2-sub"])
      expect(document.querySelector(id)?.getAttribute("maxlength")).toBe("500");
    await type(byLabel("XS, Length"), "0");
    await type(document.querySelector<HTMLInputElement>("#name")!, "");
    await click("Save");
    const banner = () => document.querySelector('s-banner[tone="critical"]');
    expect(banner()?.textContent).toContain("XS, Length is 0");
    await click("Remove table");
    expect(tables()).toEqual([]);
    expect(banner()?.textContent).not.toContain("XS, Length");
    expect(banner()?.textContent).toContain("Chart name");
  });

  it("moves a later table's findings up when a table before it is removed", async () => {
    await open([twoTables()]);
    await click("Clone table");
    await type(byLabel("XS, Length"), "0");
    await click("Save");
    await click("2. Garment measurements");
    await click("Remove table");
    expect(document.querySelectorAll(".tablerow")).toHaveLength(1);
    const banner = document.querySelector('s-banner[tone="critical"]')!;
    await act(async () => banner.querySelector("a")!.click());
    await settle();
    expect(tables()).toContain("2. Garment measurements *");
    expect(document.activeElement).toBe(byLabel("XS, Length"));
    expect(byLabel("XS, Length").getAttribute("aria-invalid")).toBe("true");
  });

  it("asks before leaving with unsaved edits in table 2", async () => {
    bridge.saveBar.leaveConfirmation.mockReturnValue(new Promise(() => {}));
    await open([twoTables()]);
    await click("Edit table");
    await type(byLabel("XS, Length"), "30");
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>("a")]
        .find((a) => a.textContent === "Size charts")!
        .click(),
    );
    await settle();
    expect(bridge.saveBar.leaveConfirmation).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain("Left for");
    expect(byLabel("XS, Length").value).toBe("30");
  });
});

describe("Media tab", () => {
  const field = () => document.querySelector<HTMLInputElement>("#video")!;
  const openMedia = async () => {
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>(".tab")]
        .find((b) => b.textContent === "Media")!
        .click(),
    );
  };

  it("marks a link that isn't YouTube or Vimeo as it's typed, and saves a good one", async () => {
    const { sent } = await open([stored()]);
    await openMedia();
    expect(text()).toContain("A YouTube or Vimeo link, one per chart.");
    await type(field(), "https://www.tiktok.com/@north-linen/video/1");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().getAttribute("aria-describedby")).toBe("video-err");
    expect(document.querySelector("#video-err")?.textContent).toBe(
      "Use an https link from YouTube or Vimeo.",
    );
    expect(text()).not.toContain("YouTube video");
    await click("Save");
    expect(sent).toEqual([]);
    const banner = document.querySelector('s-banner[tone="critical"]')!;
    expect(banner.querySelector("a")?.getAttribute("href")).toBe("#video");
    await type(field(), "https://www.youtube.com/watch?v=abc");
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(text()).toContain("YouTube video");
    expect(text()).toContain("Plays inside the size guide.");
    await click("Save");
    expect(validateChart(sent[0].chart).content.videoUrl).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
  });

  it("opens from the Fit video box, and Remove video saves the chart without it", async () => {
    const withVideo = stored();
    withVideo.stored.chart.content.videoUrl = "https://vimeo.com/76979871";
    const { sent } = await open([withVideo]);
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>(".boxes .drop")]
        .find((b) => b.textContent?.startsWith("Fit video"))!
        .click();
    });
    await settle();
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("https://vimeo.com/76979871");
    expect(text()).toContain("Vimeo video");
    await click("Remove video");
    expect(field().value).toBe("");
    await click("Save");
    expect("videoUrl" in validateChart(sent[0].chart).content).toBe(false);
  });
});
