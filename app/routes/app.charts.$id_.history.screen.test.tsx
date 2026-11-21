// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChartInput } from "../models/chart.server";

// The VersionHistory board's states; the route's server half is tested in
// app.charts.$id_.history.test.ts.
vi.mock("../shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../db.server", () => ({ default: {} }));
const { default: VersionHistory } = await import("./app.charts.$id_.history");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const chart = (bust: [number, number], note?: string): ChartInput => ({
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
        rows: [
          { id: "s", cells: { bust } },
          { id: "m", cells: { bust: [35, 36] } },
        ],
      },
    ],
    measure: { steps: [] },
    words: {
      "t1.size": "Size",
      "t1.bust": "Bust",
      "t1.s.size": "S",
      "t1.m.size": "M",
      ...(note && { "t1.note": note }),
    },
  },
});
const v = (id: number, when: string, by: string, c: ChartInput) => ({
  id,
  when,
  by,
  what: `Version ${id} summary`,
  chart: c,
});
const loaded = (n = 3) => ({
  limit: 30,
  name: "Women's tops",
  current: chart([33, 34]),
  versions: [
    v(3, "Nov 14, 2026 · 3:42 PM", "Priya N.", chart([33, 34])),
    v(2, "Nov 12, 2026 · 10:05 AM", "Jordan K.", chart([33, 35], "Size up")),
    v(1, "Nov 3, 2026 · 9:30 AM", "Imported from Kiwi", chart([33, 34])),
  ].slice(0, n),
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

async function open(loads: unknown[]) {
  const loader = vi.fn(
    () => loads[Math.min(loader.mock.calls.length - 1, loads.length - 1)],
  );
  const Stub = createRoutesStub([
    {
      path: "/app/charts/:id/history",
      Component: VersionHistory,
      HydrateFallback: () => null,
      loader,
    },
  ]);
  const div = document.body.appendChild(document.createElement("div"));
  root = createRoot(div);
  await act(async () =>
    root!.render(<Stub initialEntries={["/app/charts/42/history"]} />),
  );
  await settle();
  return { loader };
}
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("button, s-button")].find((b) =>
    b.textContent?.startsWith(label),
  )!;
const click = async (label: string) => {
  await act(async () => button(label).click());
  await settle();
};
const preview = () => document.querySelector("[aria-labelledby=vprev]")!;

describe("version history screen", () => {
  it("lists the versions and previews the one before the current, marking what differs", async () => {
    await open([loaded()]);
    expect(text()).toContain("Version history");
    expect(text()).toContain(
      "Fitted keeps the last 30 versions of each chart.",
    );
    expect(
      document.querySelector('a[href="/app/charts/42"]')?.textContent,
    ).toBe("Women's tops");
    expect(button("Nov 14, 2026").textContent).toContain("Current");
    expect(button("Nov 12, 2026").getAttribute("aria-pressed")).toBe("true");
    expect(button("Nov 14, 2026").getAttribute("aria-pressed")).toBe("false");
    const p = preview().textContent;
    expect(p).toContain("Saved by Jordan K.");
    expect(p).toContain("Preview, read only");
    expect(p).toContain("Bust (in)");
    expect(p).toContain("Underlined values differ from the current version");
    expect(p).toContain("Note under the table: Size up");
    const diff = preview().querySelectorAll(".diff");
    expect([...diff].map((d) => d.textContent)).toEqual(["33–35"]);
    // Screen readers hear what it is now, not only the underline.
    expect(p).toContain("33–35 (now 33–34)");
  });

  it("previews the picked version, and marks nothing on one like the current", async () => {
    await open([loaded()]);
    await click("Nov 14, 2026");
    expect(preview().textContent).toContain(
      "Current version · saved by Priya N.",
    );
    expect(button("Nov 14, 2026").getAttribute("aria-pressed")).toBe("true");
    await click("Nov 3, 2026");
    expect(preview().textContent).toContain("Saved by Imported from Kiwi");
    expect(preview().querySelectorAll(".diff")).toHaveLength(0);
    expect(text()).not.toContain("Underlined values differ");
  });

  it("says when the history fails to load, and tries again", async () => {
    const { loader } = await open([
      { error: { code: "shopify", message: "x" } },
      loaded(),
    ]);
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "We couldn't load this chart's versions",
    );
    expect(text()).toContain("Only the history failed to load.");
    expect(
      document.querySelector('a.btn2[href="/app/charts/42"]')?.textContent,
    ).toBe("Back to the chart");
    await click("Try again");
    expect(loader).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Saved versions");
  });

  it("tells staff without Products access so under its title, and tries again", async () => {
    const { loader } = await open([
      { error: { code: "access", message: "x" } },
      loaded(),
    ]);
    expect(document.querySelector("h1")?.textContent).toBe("Version history");
    expect(document.querySelector("s-banner")?.getAttribute("heading")).toBe(
      "You need Products access",
    );
    expect(text()).toContain(
      "Fitted can't show this page without it. Ask the store owner to add it to your account in Settings › Users.",
    );
    expect(text()).not.toContain("We couldn't load this chart's versions");
    await click("Try again");
    expect(loader).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Saved versions");
  });

  it("shows the loading state while the versions load again", async () => {
    let finish = () => {};
    const slow = new Promise<ReturnType<typeof loaded>>(
      (r) => (finish = () => r(loaded())),
    );
    await open([{ error: { code: "shopify", message: "x" } }, slow]);
    await act(async () => button("Try again").click());
    expect(document.querySelector("[role=status]")?.textContent).toBe(
      "Loading versions",
    );
    // The list skeleton is the first column, as the list is once loaded.
    expect(
      document.querySelector("[aria-busy=true] > :first-child")?.className,
    ).toBe("card sks");
    expect(text()).not.toContain("Saved versions");
    await act(async () => finish());
    await settle();
    expect(text()).toContain("Saved versions");
  });

  it("explains a chart with only one version", async () => {
    await open([loaded(1)]);
    expect(text()).toContain("Only one version so far");
    expect(button("Nov 14, 2026").textContent).toContain("Current");
    expect(preview()).toBeNull();
    expect(
      document.querySelector('a.btn2[href="/app/charts/42"]')?.textContent,
    ).toBe("Back to the chart");
  });
});
