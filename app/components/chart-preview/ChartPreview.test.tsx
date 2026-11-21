// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChartInput } from "../../models/chart.server";
import { defaultSettings } from "../../models/settings.server";
import { blankDraft, setWord, toDraft, type Draft } from "../chart-table/model";
import { ChartPreview, type Look, previewGuide } from "./ChartPreview";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const chart = (): ChartInput => ({
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
          { id: "xs", cells: { bust: [31, 32] } },
          { id: "s", cells: { bust: [33, 34] } },
        ],
      },
    ],
    measure: { steps: ["b"] },
    videoUrl: "https://youtu.be/abc",
    fit: {
      table: "t1",
      questions: [{ id: "q1", kind: "usual_size" }],
      ease: {},
      stretch: "none",
    },
    words: {
      "t1.size": "Size",
      "t1.bust": "Bust",
      "t1.xs.size": "XS",
      "t1.s.size": "S",
      "m.b.name": "Bust",
      "m.b.text": "Measure around the fullest part of your chest.",
      "fit.q1": "What size do you usually wear?",
    },
  },
});
const draft = (): Draft => toDraft(chart(), "DRAFT");
const look = (patch: Partial<Look> = {}): Look => ({
  settings: defaultSettings("en"),
  primaryLocale: "en",
  plan: "free",
  products: { count: 148, atLeast: false },
  ...patch,
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
type Props = Parameters<typeof ChartPreview>[0];
let show: (p: Props) => Promise<void>;
// Draws the preview, and again with new props as the editor's edits arrive.
async function open(p: Props) {
  let set: (p: Props) => void = () => {};
  function Host() {
    const [props, setProps] = useState(p);
    set = setProps;
    return <ChartPreview {...props} />;
  }
  const Stub = createRoutesStub([{ path: "/", Component: Host }]);
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Stub />));
  await settle();
  show = async (next) => {
    await act(async () => set(next));
    await settle();
  };
}

const frame = () => document.querySelector("iframe")!.contentDocument!;
const inFrame = () => frame().body.textContent ?? "";
const text = () => document.body.textContent ?? "";

describe("the guide's data", () => {
  it("is what the storefront's snippet prints for the draft", () => {
    const p = previewGuide(draft(), look(), "https://cdn.shopify.com/m.png");
    if (p === "empty") throw new Error("empty");
    expect(p.stale).toBe(false);
    const { raw } = p.guide!;
    expect(raw).toMatchObject({
      measureImage: "https://cdn.shopify.com/m.png",
      css: "",
      text: { label: "Size guide", header: "Size guide" },
      locale: "en",
      plan: "free",
    });
    const c = raw.chart as Record<string, unknown>;
    expect(c.tables).toEqual(chart().content.tables);
    expect(c.measure).toEqual({ steps: ["b"] });
    // No video link, and the fit finder only on Pro, as the snippet prints them.
    expect(c).not.toHaveProperty("videoUrl");
    expect(c).not.toHaveProperty("fit");
    const pro = previewGuide(draft(), look({ plan: "pro" }));
    if (pro === "empty") throw new Error("empty");
    expect(pro.guide!.raw.chart).toHaveProperty("fit", chart().content.fit);
  });

  it("opens in the chart's own unit where the storefront goes by country", () => {
    const d = toDraft(
      { ...chart(), content: { ...chart().content, unit: "cm" } },
      "DRAFT",
    );
    const p = previewGuide(d, look());
    expect(p !== "empty" && p.guide!.sys).toBe("cm");
    const s = defaultSettings("en");
    s.units.default = "in";
    const q = previewGuide(d, look({ settings: s }));
    expect(q !== "empty" && q.guide!.sys).toBe("in");
  });

  it("is stale while a cell fails the checks, leaving that value out", () => {
    const d = { ...draft(), cells: { ...draft().cells, "xs.bust": "31–" } };
    const p = previewGuide(d, look());
    if (p === "empty") throw new Error("empty");
    expect(p.stale).toBe(true);
    expect(p.guide!.tables[0].rows[0].cells).toEqual({});
  });

  it("is empty before the chart has a size", () => {
    expect(previewGuide(blankDraft(), look())).toBe("empty");
  });
});

describe("live preview", () => {
  it("draws the draft with the storefront's guide, in its own frame", async () => {
    await open({ draft: draft(), look: look(), tab: "table" });
    expect(frame().querySelector(".fitted-title")?.textContent).toBe(
      "Size guide",
    );
    expect(frame().querySelector(".fitted-sub")?.textContent).toBe(
      "Women's tops",
    );
    const head = [...frame().querySelectorAll("thead th")].map(
      (th) => th.textContent,
    );
    expect(head).toEqual(["Size", "Bust"]);
    expect(inFrame()).toContain("31–32");
    expect(
      frame().querySelector(".fitted-body")?.getAttribute("data-t-chart"),
    ).toBe("Size chart");
    // The guide's styles reach the frame, and the merchant's CSS stays there.
    expect(frame().querySelector("style")?.textContent).toContain(
      ".fitted-table",
    );
    expect(frame().body.inert).toBe(true);
    expect(text()).toContain("Shown on 148 products");
    expect(document.querySelector('a[href="/app/rules"]')?.textContent).toBe(
      "Edit display rules",
    );
  });

  it("follows the editor's unsaved edits", async () => {
    await open({ draft: draft(), look: look(), tab: "table" });
    const d = draft();
    await show({
      draft: {
        ...setWord(d, "t1.bust", "Chest"),
        cells: { ...d.cells, "xs.bust": "30–31" },
      },
      look: look(),
      tab: "table",
    });
    expect(inFrame()).toContain("Chest");
    expect(inFrame()).toContain("30–31");
    expect(inFrame()).not.toContain("31–32");
  });

  it("keeps the last table that passed while a cell needs fixing", async () => {
    await open({ draft: draft(), look: look(), tab: "table" });
    const d = draft();
    await show({
      draft: { ...d, cells: { ...d.cells, "xs.bust": "abc" } },
      look: look(),
      tab: "table",
    });
    expect(
      document.querySelector('s-banner[tone="warning"]')?.textContent,
    ).toBe(
      "Showing the last table that passed. Fix the marked cells to update it.",
    );
    expect(inFrame()).toContain("31–32");
    await show({
      draft: { ...d, cells: { ...d.cells, "xs.bust": "29" } },
      look: look(),
      tab: "table",
    });
    expect(document.querySelector("s-banner")).toBeNull();
    expect(inFrame()).toContain("29");
  });

  it("follows the Appearance settings", async () => {
    const s = defaultSettings("en");
    s.colors = {
      mode: "custom",
      text: "#111111",
      accent: "#aa0000",
      background: "#fafafa",
    };
    s.text.en.header = "Find your fit";
    s.popup.rtl = true;
    s.css = ".fitted-title{letter-spacing:2px}";
    s.popup.font = {
      fileUrl: "https://cdn.shopify.com/s/files/1/brand.woff2",
    };
    await open({ draft: draft(), look: look({ settings: s }), tab: "table" });
    const block = frame().querySelector<HTMLElement>(".fitted-guide")!;
    expect(block.style.getPropertyValue("--fitted-accent")).toBe("#aa0000");
    expect(block.style.getPropertyValue("--fitted-bg")).toBe("#fafafa");
    expect(frame().querySelector(".fitted-title")?.textContent).toBe(
      "Find your fit",
    );
    expect(frame().querySelector(".fitted-dialog")?.getAttribute("dir")).toBe(
      "rtl",
    );
    expect(frame().querySelector("style")?.textContent).toContain(
      ".fitted-title{letter-spacing:2px}",
    );
    expect(document.head.innerHTML).not.toContain("letter-spacing:2px");
    // The uploaded font, with the frame's own standing in while it loads.
    expect(frame().querySelector("style")?.textContent).toContain(
      '@font-face{font-family:fitted-font;src:url("https://cdn.shopify.com/s/files/1/brand.woff2")',
    );
    expect(block.style.getPropertyValue("--fitted-font")).toMatch(
      /^fitted-font,system-ui/,
    );
  });

  it("writes the merchant's words as text, never as HTML", async () => {
    const d = setWord(
      { ...draft(), name: '<img src="x" onerror="alert(1)">' },
      "t1.xs.size",
      "<b>XS</b>",
    );
    await open({ draft: d, look: look(), tab: "table" });
    expect(frame().querySelector("img, b")).toBeNull();
    expect(frame().querySelector(".fitted-sub")?.textContent).toBe(
      '<img src="x" onerror="alert(1)">',
    );
    expect(inFrame()).toContain("<b>XS</b>");
  });

  it("shows How to measure while the editor does", async () => {
    await open({ draft: draft(), look: look(), tab: "measure" });
    const tab = frame().querySelector('[data-fitted-tab="measure"]');
    expect(tab?.getAttribute("aria-pressed")).toBe("true");
    expect(frame().querySelector<HTMLElement>(".fitted-measure")?.hidden).toBe(
      false,
    );
    expect(inFrame()).toContain("Measure around the fullest part");
  });

  it("shows Find my size on Pro only, as shoppers see it", async () => {
    await open({ draft: draft(), look: look(), tab: "table" });
    expect(frame().querySelector('[data-fitted-tab="fit"]')).toBeNull();
    await show({ draft: draft(), look: look({ plan: "pro" }), tab: "table" });
    expect(frame().querySelector('[data-fitted-tab="fit"]')?.textContent).toBe(
      "Find my size",
    );
  });

  it("switches between desktop and phone", async () => {
    await open({ draft: draft(), look: look(), tab: "table" });
    const btn = (label: string) =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent === label,
      )!;
    expect(btn("Desktop").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("iframe")?.style.width).toBe("720px");
    await act(async () => btn("Phone").click());
    await settle();
    expect(btn("Phone").getAttribute("aria-pressed")).toBe("true");
    expect(
      document.querySelector(".stage.phone iframe")?.getAttribute("style"),
    ).toContain("width: 390px");
    expect(inFrame()).toContain("31–32");
  });

  it("names how many products show the chart", async () => {
    const say = async (products?: Look["products"]) => {
      await show({ draft: draft(), look: look({ products }), tab: "table" });
      return document.querySelector(".preview .help")?.textContent;
    };
    await open({ draft: draft(), look: look(), tab: "table" });
    expect(await say({ count: 1, atLeast: false })).toBe("Shown on 1 product");
    expect(await say({ count: 10000, atLeast: true })).toBe(
      "Shown on 10,000+ products",
    );
    expect(await say({ count: 0, atLeast: false })).toBe(
      "Not on any products yet",
    );
    expect(await say(undefined)).toBe("Not on any products yet");
  });

  it("waits for a size before drawing anything", async () => {
    await open({ draft: blankDraft(), look: look(), tab: "table" });
    expect(text()).toContain(
      "Your size guide shows here once the chart has a size.",
    );
    expect(document.querySelector("iframe")).toBeNull();
    expect(text()).not.toContain("Edit display rules");
    expect(text()).not.toContain("Phone");
  });

  it("sends no shopper events", async () => {
    const beacon = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
    await open({ draft: draft(), look: look(), tab: "table" });
    expect(beacon).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
