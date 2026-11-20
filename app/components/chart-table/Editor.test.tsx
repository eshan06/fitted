// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChartInput, validateChart } from "../../models/chart.server";

// The route's server half needs Shopify and the database; the screen doesn't.
vi.mock("../../shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../../db.server", () => ({ default: {} }));
// The save bar is App Bridge's; here it renders its buttons in place.
vi.mock("@shopify/app-bridge-react", () => ({
  SaveBar: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="save-bar">{children}</div> : null,
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
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

// Renders the editor route with a loader and an action that answer in turn.
async function open(
  loaded: unknown[],
  answers: { status: number; body: unknown }[] = [],
  path = "/app/charts/42",
) {
  const sent: Record<string, unknown>[] = [];
  const loader = vi.fn(
    () => loaded[Math.min(loader.mock.calls.length - 1, loaded.length - 1)],
  );
  const Stub = createRoutesStub([
    {
      path: "/app/charts/:id",
      Component: ChartEditor,
      HydrateFallback: () => null,
      loader,
      action: async ({ request }) => {
        sent.push(await request.json());
        const a = answers.shift() ?? { status: 200, body: { ok: true } };
        return Response.json(a.body, { status: a.status });
      },
    },
  ]);
  const div = document.body.appendChild(document.createElement("div"));
  root = createRoot(div);
  await act(async () => root!.render(<Stub initialEntries={[path]} />));
  await settle();
  return { sent, loader };
}
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

  it("starts a new chart blank and creates it by its handle", async () => {
    const { sent } = await open(
      [{ mode: "new", handle: "c-abc" }],
      [],
      "/app/charts/new",
    );
    expect(text()).toContain("New chart");
    expect(text()).toContain("A blank chart, ready for sizes");
    expect(document.querySelector('[aria-label="Chart status"]')).toBeNull();
    await type(document.querySelector<HTMLInputElement>("#name")!, "Jeans");
    await act(async () => button("Add size").click());
    await type(byLabel("Size 1"), "28");
    await click("Save");
    expect(sent).toEqual([
      { handle: "c-abc", chart: expect.objectContaining({ name: "Jeans" }) },
    ]);
  });

  it("links More actions to the chart's version history, except on a new chart", async () => {
    await open([stored()]);
    const link = [...document.querySelectorAll("a")].find(
      (a) => a.textContent === "Version history",
    );
    expect(link?.getAttribute("href")).toBe("/app/charts/42/history");
    act(() => root?.unmount());
    await open([{ mode: "new", handle: "c-abc" }], [], "/app/charts/new");
    expect(text()).not.toContain("More actions");
  });

  it("says when a save landed but version history missed it", async () => {
    await open(
      [stored()],
      [{ status: 200, body: { ok: true, historyMissed: true } }],
    );
    const missed = () =>
      document
        .querySelector('s-banner[tone="warning"]')
        ?.getAttribute("heading");
    expect(missed()).toBeUndefined();
    await type(byLabel("XS, Bust"), "31.5–32");
    await click("Save");
    expect(missed()).toBe("Saved, but version history missed it");
    expect(text()).toContain("This save won't show in version history.");
    act(() => root?.unmount());
    // A new chart whose first version wasn't recorded opens saying so.
    await open([stored()], [], "/app/charts/42?history=missed");
    expect(missed()).toBe("Saved, but version history missed it");
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
});
