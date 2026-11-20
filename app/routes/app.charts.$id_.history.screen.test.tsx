// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChartInput } from "../models/chart.server";

// The VersionHistory board's states; the route's server half is tested in
// app.charts.$id_.history.test.ts.
const toast = vi.hoisted(() => vi.fn());
vi.mock("../shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../db.server", () => ({ default: {} }));
vi.mock("@shopify/app-bridge-react", () => ({
  useAppBridge: () => ({ toast: { show: toast } }),
}));
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
const v = (id: string, when: string, by: string, c: ChartInput) => ({
  id,
  when,
  by,
  what: `${id} summary`,
  chart: c,
});
const loaded = (n = 3) => ({
  name: "Women's tops",
  current: chart([33, 34]),
  versions: [
    v("v3", "Nov 14, 2026 · 3:42 PM", "Priya N.", chart([33, 34])),
    v("v2", "Nov 12, 2026 · 10:05 AM", "Jordan K.", chart([33, 35], "Size up")),
    v("v1", "Nov 3, 2026 · 9:30 AM", "Imported from Kiwi", chart([33, 34])),
  ].slice(0, n),
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  toast.mockReset();
});

async function open(
  loads: unknown[],
  answers: { status: number; body: unknown }[] = [],
) {
  const sent: unknown[] = [];
  const loader = vi.fn(
    () => loads[Math.min(loader.mock.calls.length - 1, loads.length - 1)],
  );
  const Stub = createRoutesStub([
    {
      path: "/app/charts/:id/history",
      Component: VersionHistory,
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
  await act(async () =>
    root!.render(<Stub initialEntries={["/app/charts/42/history"]} />),
  );
  await settle();
  return { sent, loader };
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
    expect(button("Nov 14, 2026").textContent).toContain("Current");
    expect(button("Nov 12, 2026").getAttribute("aria-pressed")).toBe("true");
    const p = preview().textContent;
    expect(p).toContain("Saved by Jordan K.");
    expect(p).toContain("Bust (in)");
    expect(p).toContain("Underlined values differ from the current version");
    expect(p).toContain("Note under the table: Size up");
    const diff = preview().querySelectorAll(".diff");
    expect([...diff].map((d) => d.textContent)).toEqual(["33–35"]);
    expect(p).toContain("33–35 (now 33–34)");
    expect(button("Restore this version").hasAttribute("disabled")).toBe(false);
  });

  it("won't restore the current version, and marks nothing on an identical one", async () => {
    await open([loaded()]);
    await click("Nov 14, 2026");
    expect(preview().textContent).toContain(
      "Current version · saved by Priya N.",
    );
    expect(button("Restore this version").hasAttribute("disabled")).toBe(true);
    expect(text()).toContain("This is the version shoppers see now.");
    await click("Nov 3, 2026");
    expect(preview().querySelectorAll(".diff")).toHaveLength(0);
    expect(text()).not.toContain("Underlined values differ");
  });

  it("restores the picked version and shows the new current one", async () => {
    const restored = loaded();
    restored.versions.unshift(
      v("v4", "Nov 18, 2026 · 11:20 AM", "Priya N.", chart([33, 35])),
    );
    const { sent } = await open([loaded(), restored]);
    await click("Restore this version");
    expect(sent).toEqual([{ version: "v2" }]);
    expect(toast).toHaveBeenCalledWith("Restored. Saved as a new version.");
    expect(preview().textContent).toContain("Nov 18, 2026 · 11:20 AM");
    expect(button("Nov 18, 2026").getAttribute("aria-pressed")).toBe("true");
  });

  it("says a failed restore changed nothing, and tries again", async () => {
    const message = "Fitted couldn't save to Shopify just now.";
    const { sent } = await open(
      [loaded()],
      [{ status: 502, body: { error: { message } } }],
    );
    await click("Restore this version");
    expect(
      document
        .querySelector('s-banner[tone="critical"]')
        ?.getAttribute("heading"),
    ).toBe("This version wasn't restored");
    expect(text()).toContain(message);
    expect(toast).not.toHaveBeenCalled();
    await click("Try again");
    expect(sent).toEqual([{ version: "v2" }, { version: "v2" }]);
    expect(document.querySelector("s-banner")).toBeNull();
  });

  it("says when the history fails to load, and tries again", async () => {
    const { loader } = await open([{ error: true }, loaded()]);
    expect(text()).toContain("We couldn't load this chart's versions");
    expect(text()).toContain("Only the history failed to load.");
    await click("Try again");
    expect(loader).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Saved versions");
  });

  it("explains a chart with only one version", async () => {
    await open([loaded(1)]);
    expect(text()).toContain("Only one version so far");
    expect(text()).not.toContain("Restore this version");
    expect(
      document.querySelector('a.btn2[href="/app/charts/42"]')?.textContent,
    ).toBe("Back to the chart");
  });
});
