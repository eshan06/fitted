// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parseGuide, render } from "./guide";

// How to measure (ARCHITECTURE §9), from the Storefront board.
const en = JSON.parse(
  readFileSync("extensions/size-guide/locales/en.default.json", "utf8"),
).size_guide;

const words = {
  "t1.m.size": "M",
  "m.b.name": "Bust",
  "m.b.text":
    "Measure around the fullest part of your chest, keeping the tape level.",
  "m.w.name": "Waist",
  "m.w.text":
    "Measure around your natural waistline, the narrowest part of your torso.",
  "m.h.name": "Hips",
  "m.h.text":
    "Stand with your feet together and measure around the fullest part of your hips.",
};
// The drawing as Liquid's image_url prints it: the store's own domain.
const drawing = `//${location.host}/cdn/shop/files/measure-tops.png?v=1&width=1000`;
const fit = {
  table: "t1",
  questions: [{ id: "q1", kind: "usual_size" }],
  ease: {},
  stretch: "none",
};
// What the data snippet prints (§9), with the chart's measure as given.
const data = (
  over: Record<string, unknown> = {},
  measure: unknown = { steps: ["b", "w", "h"] },
  more: Record<string, unknown> = {},
) =>
  JSON.stringify({
    chart: {
      v: 1,
      unit: "in",
      roundTo: 0.5,
      tables: [
        {
          id: "t1",
          columns: [{ id: "size", kind: "size" }],
          rows: [{ id: "m", cells: {} }],
        },
      ],
      measure,
      words,
      ...more,
    },
    strings: {},
    measureImage: drawing,
    country: "US",
    locale: "en",
    ...over,
  });
// The guide with the extension's words on its root, as the block passes them.
const open = (json: string) => {
  const g = parseGuide(json);
  if (!g) throw new Error("expected a guide");
  const root = document.createElement("div");
  for (const [k, v] of Object.entries<string>(en))
    root.dataset[`t${k[0].toUpperCase()}${k.slice(1)}`] = v;
  document.body.append(root);
  render(root, g);
  return root;
};
const buttons = (root: Element) => [
  ...root.querySelectorAll<HTMLButtonElement>(".fitted-tabs button"),
];
const tabs = (root: Element) =>
  buttons(root).map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
const pane = (root: Element) =>
  root.querySelector<HTMLElement>(".fitted-measure");
const steps = (root: Element) =>
  [...root.querySelectorAll(".fitted-steps li")].map((li) => li.textContent);
const shown = (el: Element | null) => !!el && !el.closest("[hidden]");
const plain = [
  `Bust. ${words["m.b.text"]}`,
  `Waist. ${words["m.w.text"]}`,
  `Hips. ${words["m.h.text"]}`,
];

afterEach(() => document.body.replaceChildren());

describe("How to measure", () => {
  it("comes after the Size chart, with a tab bar on every plan", () => {
    for (const plan of ["free", "standard", "pro", null])
      expect(tabs(open(data({ plan })))).toEqual([
        ["Size chart", "true"],
        ["How to measure", "false"],
      ]);
    // On Pro with a fit finder, before Find my size.
    expect(tabs(open(data({ plan: "pro" }, undefined, { fit })))).toEqual([
      ["Size chart", "true"],
      ["How to measure", "false"],
      ["Find my size", "false"],
    ]);
  });

  it("numbers the steps, each saying its line on the drawing, as drawn", () => {
    const root = open(data());
    expect(steps(root)).toEqual([
      `Bust. Line 1 on the drawing. ${words["m.b.text"]}`,
      `Waist. Line 2. ${words["m.w.text"]}`,
      `Hips. Line 3. ${words["m.h.text"]}`,
    ]);
    expect(
      [...root.querySelectorAll(".fitted-steps strong")].map(
        (s) => s.textContent,
      ),
    ).toEqual(["Bust.", "Waist.", "Hips."]);
    expect(root.querySelector(".fitted-steps")?.tagName).toBe("OL");
  });

  it("shows the drawing from Shopify's CDN: the store's own path, or cdn.shopify.com as the admin has it", () => {
    const img = pane(open(data()))?.querySelector("img");
    expect(img?.getAttribute("src")).toBe(new URL(drawing, location.href).href);
    expect(img?.getAttribute("alt")).toBe("Measuring drawing");
    expect(img?.getAttribute("loading")).toBe("lazy");
    const admin = "https://cdn.shopify.com/s/files/1/0001/files/measure.png";
    const own = open(data({ measureImage: admin }));
    expect(own.querySelector("img")?.getAttribute("src")).toBe(admin);
  });

  it.each([
    ["another site", "https://tracker.example/cdn/shop/files/m.png"],
    ["another site's CDN path", "//tracker.example/cdn/shop/files/m.png"],
    ["the store's own pages", `//${location.host}/pages/m.png`],
    ["Shopify over http", "http://cdn.shopify.com/s/files/m.png"],
    ["a script", "javascript:alert(1)"],
    ["inline data", "data:image/png;base64,iVBORw0KGgo="],
    ["no text", 5],
  ])(
    "leaves out a drawing from %s, and the lines it would name",
    (_, measureImage) => {
      const root = open(data({ measureImage }));
      expect(root.querySelector("img")).toBeNull();
      expect(steps(root)).toEqual(plain);
    },
  );

  it("shows steps without a drawing, and a drawing without steps", () => {
    expect(steps(open(data({ measureImage: null })))).toEqual(plain);
    const only = open(data({}, { steps: [] }));
    expect(only.querySelector(".fitted-steps")).toBeNull();
    expect(pane(only)?.querySelector("img")).not.toBeNull();
    expect(tabs(only).map(([w]) => w)).toEqual([
      "Size chart",
      "How to measure",
    ]);
  });

  it.each([
    ["no steps", { steps: [] }],
    ["a measure that isn't one", null],
    ["steps that aren't a list", { steps: "b" }],
    ["a step id that isn't one", { steps: ["b", '"><img src=x>'] }],
    ["21 steps", { steps: Array.from({ length: 21 }, (_, i) => `s${i}`) }],
  ])(
    "has no tab and no tab bar with %s and no drawing, and still draws the Size chart",
    (_, measure) => {
      const root = open(data({ measureImage: null }, measure));
      expect(root.querySelector(".fitted-tabs, .fitted-measure")).toBeNull();
      expect(root.querySelector("table")).not.toBeNull();
    },
  );

  it("prints the merchant's words as text, never as HTML", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const root = open(
      data({ strings: { "m.b.name": evil, "m.b.text": evil } }),
    );
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.querySelector("script")).toBeNull();
    expect(steps(root)[0]).toBe(`${evil}. Line 1 on the drawing. ${evil}`);
  });

  it("switches from the Size chart and back, the footer and the pick staying", () => {
    const root = open(data());
    const [chart, measure] = buttons(root);
    const foot = root.querySelector(".fitted-foot");
    root.querySelector<HTMLElement>("tbody th button")?.click();
    expect([shown(pane(root)), shown(foot)]).toEqual([false, true]);
    measure.click();
    expect(shown(pane(root))).toBe(true);
    expect(shown(root.querySelector("table"))).toBe(false);
    expect(shown(foot)).toBe(true);
    expect(foot?.querySelector("strong")?.textContent).toBe("Selected: M");
    expect(tabs(root).map(([, on]) => on)).toEqual(["false", "true"]);
    // The footer stays at the bottom, under the steps.
    expect(
      pane(root)!.compareDocumentPosition(foot!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    chart.click();
    expect(shown(pane(root))).toBe(false);
    expect(shown(root.querySelector("table"))).toBe(true);
    expect(root.querySelector(".fitted-on th")?.textContent).toBe("M");
  });

  it("hides with the footer on Find my size", () => {
    const root = open(data({ plan: "pro" }, undefined, { fit }));
    const [, measure, finder] = buttons(root);
    const foot = root.querySelector(".fitted-foot");
    root.querySelector<HTMLElement>("tbody th button")?.click();
    finder.click();
    expect(shown(pane(root))).toBe(false);
    expect(shown(foot)).toBe(false);
    expect(shown(root.querySelector(".fitted-fit"))).toBe(true);
    measure.click();
    expect([shown(pane(root)), shown(foot)]).toEqual([true, true]);
    expect(shown(root.querySelector(".fitted-fit"))).toBe(false);
  });
});
