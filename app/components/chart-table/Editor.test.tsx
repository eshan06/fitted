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
    await click("Try saving again");
    expect(sent[1]).toMatchObject({ updatedAt: "2026-11-19T10:05:00Z" });
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
});
