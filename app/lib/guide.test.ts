// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGuide, render } from "./guide";
import { tableCss } from "./guide-css";

const en = JSON.parse(
  readFileSync("extensions/size-guide/locales/en.default.json", "utf8"),
).size_guide;

// Loose on purpose: the tests write invalid charts into it.
type Fixture = {
  v: unknown;
  unit: unknown;
  roundTo: unknown;
  tables: {
    id: string;
    columns: unknown[];
    rows: { id: string; cells: Record<string, unknown> }[];
    merges?: unknown;
    wrap?: unknown;
  }[];
  words: Record<string, unknown>;
};
// The canvas's Linen Wrap Top, plus a weight column and one kept as typed.
const chart = (): Fixture => ({
  v: 1,
  unit: "in",
  roundTo: 0.5,
  tables: [
    {
      id: "t1",
      columns: [
        { id: "size", kind: "size" },
        { id: "us", kind: "country", country: "US" },
        { id: "bust", kind: "measure", convert: true },
        { id: "wt", kind: "measure", unit: "lb", convert: true },
        { id: "len", kind: "measure", unit: "cm", convert: false },
        { id: "fit", kind: "text" },
      ],
      rows: [
        { id: "s", cells: { bust: [33, 34], wt: [110], len: [60] } },
        { id: "m", cells: { bust: [35.5] } },
      ],
    },
  ],
  words: {
    "t1.size": "Size",
    "t1.bust": "Bust",
    "t1.wt": "Weight",
    "t1.len": "Length",
    "t1.fit": "Fit",
    "t1.s.size": "S",
    "t1.m.size": "M",
    "t1.s.us": "4–6",
    "t1.s.fit": "Relaxed",
    "t1.title": "Body measurements",
    "t1.sub": "Measured on the body",
    "t1.note": "Between sizes? Size up for a relaxed fit.",
    tips: "Measure over light clothing.",
  },
});
// The toggle is off here, so headers name every unit; its tests turn it on.
const data = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    chart: chart(),
    strings: {},
    units: { default: "country", toggle: false },
    country: "US",
    locale: "en",
    ...over,
  });
const json = (
  edit: (c: Fixture) => void,
  over: Record<string, unknown> = {},
) => {
  const c = chart();
  edit(c);
  return data({ chart: c, ...over });
};
const withChart = (edit: (c: Fixture) => void) => json(edit);
// The extension's words, as the block passes them on .fitted-body, under any
// a test sets on root first.
const show = (
  json: string,
  root: HTMLElement = document.createElement("div"),
) => {
  const g = parseGuide(json);
  if (!g) throw new Error("expected a guide");
  for (const [k, v] of Object.entries<string>(en))
    root.dataset[`t${k[0].toUpperCase()}${k.slice(1)}`] ??= v;
  return { root, sync: render(root, g) };
};
const draw = (json: string) => show(json).root;
const texts = (root: Element, selector: string) =>
  [...root.querySelectorAll(selector)].map((el) => el.textContent);

describe("parseGuide", () => {
  it("reads a valid chart, with the shopper's translations over the words", () => {
    const g = parseGuide(
      data({ strings: { "t1.bust": "Poitrine", "t1.wt": 5 } }),
    );
    expect(g).toMatchObject({
      unit: "in",
      roundTo: 0.5,
      sys: "in",
      locale: "en",
    });
    expect(g?.words["t1.bust"]).toBe("Poitrine");
    // A translation that isn't text leaves the source word.
    expect(g?.words["t1.wt"]).toBe("Weight");
  });

  it("falls back to English for a locale Intl can't read", () => {
    expect(parseGuide(data({ locale: "en_US!" }))?.locale).toBe("en");
    expect(parseGuide(data({ locale: null }))?.locale).toBe("en");
    expect(parseGuide(data({ locale: "pt-br" }))?.locale).toBe("pt-BR");
    expect(() => draw(data({ locale: "en_US!" }))).not.toThrow();
  });

  it("picks units by the shopper's country unless settings fix them", () => {
    expect(parseGuide(data({ country: "US" }))?.sys).toBe("in");
    expect(parseGuide(data({ country: "LR" }))?.sys).toBe("in");
    expect(parseGuide(data({ country: "DE" }))?.sys).toBe("cm");
    expect(parseGuide(data({ country: null }))?.sys).toBe("cm");
    const units = (u: unknown) => parseGuide(data({ units: u, country: "DE" }));
    expect(units({ default: "in", toggle: true })?.sys).toBe("in");
    expect(units({ default: "country" })?.sys).toBe("cm");
    expect(units({ default: "mm" })?.sys).toBe("cm");
    expect(parseGuide(data({ units: { default: "cm" } }))?.sys).toBe("cm");
  });

  it("reads the Appearance settings the guide applies", () => {
    const font = "https://cdn.shopify.com/s/files/1/0001/font.woff2?v=1";
    const g = parseGuide(
      data({
        text: { label: "Fit guide", header: "Find your fit", noFit: "None." },
        link: { style: "text", icon: "none" },
        popup: { rtl: true, font: { fileUrl: font } },
        colors: {
          mode: "custom",
          text: "#202223",
          accent: "#B3301C",
          background: "#fffaf0",
        },
        css: ".fitted-link { background: url(https://cdn.shopify.com/a.png) }",
      }),
    );
    expect(g).toMatchObject({
      label: "Fit guide",
      header: "Find your fit",
      icon: "none",
      rtl: true,
      font,
      colors: { text: "#202223", accent: "#B3301C", bg: "#fffaf0" },
      css: ".fitted-link { background: url(https://cdn.shopify.com/a.png) }",
    });
  });

  it("keeps the extension's words and the theme's look for settings that are missing or don't validate", () => {
    const none = {
      label: "",
      header: "",
      icon: "ruler",
      rtl: false,
      font: "",
      colors: null,
      css: "",
    };
    expect(parseGuide(data())).toMatchObject(none);
    const bad = (s: Record<string, unknown>) =>
      expect(parseGuide(data(s))).toMatchObject(none);
    bad({
      text: { label: "Fit\nguide", header: "x".repeat(201) },
      link: { icon: "star" },
      popup: { rtl: "true", font: { fileUrl: "https://evil.example/a.woff2" } },
      colors: {
        mode: "custom",
        text: "#202223",
        accent: "red",
        background: "#fff",
      },
      css: ".fitted-link { background: url(https://evil.example/t.gif) }",
    });
    bad({
      text: { label: "  ", header: 7 },
      popup: { font: { fileUrl: 'https://cdn.shopify.com/a");x:url("' } },
      colors: { mode: "theme", text: "#000000" },
      css: "</style><script>",
    });
    bad({ text: "Fit guide", popup: { font: "theme" }, css: 42 });
    // Three valid colors under "Match my theme" still leave the theme's.
    bad({
      colors: {
        mode: "theme",
        text: "#202223",
        accent: "#b3301c",
        background: "#fffaf0",
      },
    });
  });

  it.each([
    ["text that isn't JSON", "{"],
    ["no data", ""],
    ["no chart", JSON.stringify({ strings: {} })],
    ["another content version", withChart((c) => (c.v = 2))],
    ["an unknown unit", withChart((c) => (c.unit = "mm"))],
    ["an unknown rounding", withChart((c) => (c.roundTo = 0.3))],
    ["no tables", withChart((c) => (c.tables = []))],
    ["five tables", withChart((c) => (c.tables = Array(5).fill(c.tables[0])))],
    [
      "a first column that isn't the size",
      withChart((c) => c.tables[0].columns.reverse()),
    ],
    [
      "a second size column",
      withChart((c) => (c.tables[0].columns[5] = { id: "x", kind: "size" })),
    ],
    [
      "an unknown column kind",
      withChart((c) => (c.tables[0].columns[5] = { id: "x", kind: "html" })),
    ],
    [
      "an unknown country",
      withChart(
        (c) =>
          (c.tables[0].columns[1] = {
            id: "us",
            kind: "country",
            country: "FR",
          }),
      ),
    ],
    [
      "a measurement without convert",
      withChart(
        (c) => (c.tables[0].columns[2] = { id: "bust", kind: "measure" }),
      ),
    ],
    [
      "a measurement in an unknown unit",
      withChart(
        (c) =>
          (c.tables[0].columns[3] = {
            id: "wt",
            kind: "measure",
            unit: "st",
            convert: true,
          }),
      ),
    ],
    [
      "an id off the §5 pattern",
      withChart((c) => (c.tables[0].rows[0].id = "constructor")),
    ],
    ["an uppercase id", withChart((c) => (c.tables[0].id = "T1"))],
    [
      "a cell that is text",
      withChart((c) => (c.tables[0].rows[0].cells = { bust: ["33"] })),
    ],
    [
      "a cell of zero",
      withChart((c) => (c.tables[0].rows[0].cells = { bust: [0] })),
    ],
    [
      "a range from high to low",
      withChart((c) => (c.tables[0].rows[0].cells = { bust: [36, 33] })),
    ],
    [
      "a cell of three numbers",
      withChart((c) => (c.tables[0].rows[0].cells = { bust: [1, 2, 3] })),
    ],
    ["words that aren't a map", withChart((c) => (c.words = [] as never))],
    [
      "61 rows",
      withChart(
        (c) =>
          (c.tables[0].rows = Array.from({ length: 61 }, (_, i) => ({
            id: `r${i}`,
            cells: {},
          }))),
      ),
    ],
    [
      "21 columns",
      withChart((c) =>
        c.tables[0].columns.push(
          ...Array.from({ length: 15 }, (_, i) => ({
            id: `x${i}`,
            kind: "text",
          })),
        ),
      ),
    ],
    ["no columns", withChart((c) => (c.tables[0].columns = []))],
    ["no rows", withChart((c) => (c.tables[0].rows = []))],
    [
      "a cell of 10,000",
      withChart((c) => (c.tables[0].rows[0].cells = { bust: [10000] })),
    ],
    [
      "a column id off the §5 pattern",
      withChart(
        (c) => (c.tables[0].columns[5] = { id: "fit-1", kind: "text" }),
      ),
    ],
    [
      "cells that aren't a map",
      withChart((c) => (c.tables[0].rows[0].cells = [] as never)),
    ],
    [
      "a merge past the last row",
      withChart(
        (c) =>
          (c.tables[0].merges = [{ row: "m", col: "bust", rows: 2, cols: 1 }]),
      ),
    ],
    [
      "a merge past the last column",
      withChart(
        (c) =>
          (c.tables[0].merges = [{ row: "s", col: "fit", rows: 1, cols: 2 }]),
      ),
    ],
    [
      "overlapping merges",
      withChart(
        (c) =>
          (c.tables[0].merges = [
            { row: "s", col: "bust", rows: 2, cols: 2 },
            { row: "m", col: "wt", rows: 1, cols: 1 },
          ]),
      ),
    ],
    [
      "a merge of a row the table doesn't have",
      withChart(
        (c) =>
          (c.tables[0].merges = [{ row: "xl", col: "bust", rows: 1, cols: 1 }]),
      ),
    ],
    [
      "a merge of no rows",
      withChart(
        (c) =>
          (c.tables[0].merges = [{ row: "s", col: "bust", rows: 0, cols: 1 }]),
      ),
    ],
    [
      "a merge of half a column",
      withChart(
        (c) =>
          (c.tables[0].merges = [
            { row: "s", col: "bust", rows: 1, cols: 1.5 },
          ]),
      ),
    ],
    [
      "a merge of a column the table doesn't have",
      withChart(
        (c) =>
          (c.tables[0].merges = [{ row: "s", col: "chest", rows: 1, cols: 2 }]),
      ),
    ],
    ["a wrap that isn't a list", withChart((c) => (c.tables[0].wrap = "fit"))],
    [
      "a merge that isn't an object",
      withChart((c) => (c.tables[0].merges = ["s"])),
    ],
    ["merges that aren't a list", withChart((c) => (c.tables[0].merges = {}))],
    [
      "a wrap naming no column",
      withChart((c) => (c.tables[0].wrap = ["chest"])),
    ],
  ])("refuses %s, so nothing renders", (_, json) => {
    expect(parseGuide(json)).toBeNull();
  });
});

describe("render", () => {
  it("adds the tables' styles once, with the first draw", () => {
    document.getElementById("fitted-table-css")?.remove();
    draw(data());
    draw(data());
    const styles = document.querySelectorAll("#fitted-table-css");
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toBe(tableCss);
  });

  it("puts the tables' styles before the loader's, so the merchant's CSS there wins ties", () => {
    document.getElementById("fitted-table-css")?.remove();
    const loader = document.createElement("style");
    loader.id = "fitted-css";
    document.head.append(loader);
    draw(data());
    expect(document.getElementById("fitted-table-css")?.nextSibling).toBe(
      loader,
    );
    loader.remove();
  });

  it("draws the table with each measurement's units in its header", () => {
    const root = draw(data());
    expect(texts(root, "thead th")).toEqual([
      "Size",
      "US",
      "Bust (in)",
      "Weight (lb)",
      "Length (cm)",
      "Fit",
    ]);
    expect(texts(root, "tbody tr:first-child > *")).toEqual([
      "S",
      "4–6",
      "33–34",
      "110",
      "60",
      "Relaxed",
    ]);
    // Typed decimals stay as typed, like 5/8 inch.
    const typed = draw(
      withChart((c) => (c.tables[0].rows[0].cells.len = [9.625])),
    );
    expect(typed.querySelector("tbody td:nth-child(5)")?.textContent).toBe(
      "9.625",
    );
    // A missing cell or word is an empty cell.
    expect(texts(root, "tbody tr:last-child > *")).toEqual([
      "M",
      "",
      "35.5",
      "",
      "",
      "",
    ]);
    expect(root.querySelector('tbody th[scope="row"]')?.textContent).toBe("S");
    expect(texts(root, "thead th[scope=col]")).toHaveLength(6);
  });

  it("shows the table's words and the tips around it", () => {
    const root = draw(data());
    expect(root.querySelector("caption")?.textContent).toBe(
      "Body measurements",
    );
    expect(texts(root, ".fitted-note")).toEqual([
      "Measured on the body",
      "Between sizes? Size up for a relaxed fit.",
      "Measure over light clothing.",
    ]);
    // One table: its title goes in the popup's subtitle, not a heading.
    expect(root.querySelector("h3")).toBeNull();
  });

  it("converts to centimeters and kilograms, rounded to the chart's step", () => {
    const root = draw(data({ country: "DE" }));
    expect(texts(root, "thead th").slice(2, 5)).toEqual([
      "Bust (cm)",
      "Weight (kg)",
      "Length (cm)",
    ]);
    // 33 in = 83.82 cm, 34 in = 86.36 cm, 110 lb = 49.9 kg, to the nearest 0.5.
    expect(texts(root, "tbody tr:first-child td").slice(1, 4)).toEqual([
      "84–86.5",
      "50",
      "60",
    ]);
  });

  it("converts centimeters to inches and formats numbers for the locale", () => {
    const root = draw(
      withChart((c) => {
        c.unit = "cm";
        c.roundTo = 0.25;
        c.tables[0].rows[0].cells.bust = [86, 90];
      }),
    );
    // 86 cm = 33.86 in, 90 cm = 35.43 in, to the nearest 0.25.
    expect(root.querySelector("tbody td:nth-child(3)")?.textContent).toBe(
      "33.75–35.5",
    );
    const de = draw(data({ country: "DE", locale: "de" }));
    expect(de.querySelector("tbody td:nth-child(3)")?.textContent).toBe(
      "84–86,5",
    );
  });

  it("puts each table under its own heading when there are several", () => {
    const root = draw(
      withChart((c) => {
        c.tables.push({ ...c.tables[0], id: "t2" });
        Object.assign(c.words, { "t2.title": "Garment", "t2.s.size": "S" });
      }),
    );
    expect(texts(root, "h3")).toEqual(["Body measurements", "Garment"]);
    expect(texts(root, "caption")).toEqual(["Body measurements", "Garment"]);
  });

  it("names an untitled table with the extension's words", () => {
    const root = draw(withChart((c) => delete c.words["t1.title"]));
    expect(root.querySelector("caption")?.textContent).toBe("Size chart");
  });

  it("prints chart words as text, never as HTML", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const root = draw(
      data({ strings: { "t1.s.size": evil, "t1.bust": evil, tips: evil } }),
    );
    expect(root.querySelector("img, script")).toBeNull();
    expect(root.querySelector("tbody th")?.textContent).toBe(evil);
    expect(root.querySelector("thead th:nth-child(3)")?.textContent).toBe(
      `${evil} (in)`,
    );
    expect(root.textContent).toContain(evil);
  });
});

describe("the in/cm toggle", () => {
  afterEach(() => document.body.replaceChildren());
  const on = (over: Record<string, unknown> = {}) =>
    data({ units: { default: "country", toggle: true }, ...over });
  const units = (root: Element) =>
    root.querySelector(`[role="group"][aria-label="${en.units}"]`);

  it("names the shown unit once, in the toggle, and converts when pressed", () => {
    const root = draw(on());
    document.body.append(root);
    expect(texts(units(root)!, "button")).toEqual([en.in, en.cm]);
    expect(texts(units(root)!, '[aria-pressed="true"]')).toEqual([en.in]);
    // Weight isn't the unit the toggle names; length as typed is.
    expect(texts(root, "thead th")).toEqual([
      "Size",
      "US",
      "Bust",
      "Weight (lb)",
      "Length (cm)",
      "Fit",
    ]);
    const cm = units(root)!.querySelectorAll("button")[1];
    cm.focus();
    cm.click();
    expect(document.activeElement).toBe(cm);
    expect(texts(units(root)!, '[aria-pressed="true"]')).toEqual([en.cm]);
    expect(texts(root, "thead th")).toEqual([
      "Size",
      "US",
      "Bust",
      "Weight (kg)",
      "Length",
      "Fit",
    ]);
    expect(texts(root, "tbody tr:first-child td").slice(1, 4)).toEqual([
      "84–86.5",
      "50",
      "60",
    ]);
  });

  it("names units with the extension's words", () => {
    const root = document.createElement("div");
    Object.assign(root.dataset, { tIn: "pulg.", tCm: "cm.", tLb: "libras" });
    show(on(), root);
    expect(texts(units(root)!, "button")).toEqual(["pulg.", "cm."]);
    expect(texts(root, "thead th")[3]).toBe("Weight (libras)");
  });

  it("shows unless settings turn it off", () => {
    expect(units(draw(data({ units: null })))).not.toBeNull();
    expect(units(draw(data()))).toBeNull();
  });

  it("hides when nothing converts, and headers keep their units", () => {
    const root = draw(
      json(
        (c) =>
          (c.tables[0].columns = c.tables[0].columns.map((col) =>
            (col as { kind: string }).kind === "measure"
              ? { ...(col as object), convert: false }
              : col,
          )),
        { units: { default: "country", toggle: true } },
      ),
    );
    expect(units(root)).toBeNull();
    expect(texts(root, "thead th").slice(2, 5)).toEqual([
      "Bust (in)",
      "Weight (lb)",
      "Length (cm)",
    ]);
  });

  it("names the unit alone over a measurement without a label", () => {
    const root = draw(withChart((c) => delete c.words["t1.bust"]));
    expect(root.querySelector("thead th:nth-child(3)")?.textContent).toBe(
      "(in)",
    );
  });
});

describe("the US/UK/EU/AU switch", () => {
  afterEach(() => document.body.replaceChildren());
  // Columns: size, us, uk, eu, then the measurements.
  const regional = (over: Record<string, unknown> = {}) =>
    json((c) => {
      c.tables[0].columns.splice(
        2,
        0,
        { id: "uk", kind: "country", country: "UK" },
        { id: "eu", kind: "country", country: "EU" },
      );
      Object.assign(c.words, { "t1.s.uk": "8–10", "t1.s.eu": "36–38" });
    }, over);
  const group = (root: Element) =>
    root.querySelector(`[role="group"][aria-label="${en.system}"]`);
  const country = (root: Element) =>
    root.querySelector("thead th:nth-child(2)")?.textContent;

  it("shows one country column at a time, the shopper's system first", () => {
    const root = draw(regional({ country: "GB" }));
    expect(texts(group(root)!, "button")).toEqual(["US", "UK", "EU"]);
    expect(texts(group(root)!, '[aria-pressed="true"]')).toEqual(["UK"]);
    expect(texts(root, "thead th")).toHaveLength(6);
    expect(texts(root, "tbody tr:first-child > *").slice(0, 2)).toEqual([
      "S",
      "8–10",
    ]);
    expect(country(draw(regional({ country: "DE" })))).toBe("EU");
    expect(country(draw(regional({ country: "US" })))).toBe("US");
    expect(country(draw(regional({ country: "IE" })))).toBe("UK");
    // Elsewhere, the table's first country column.
    expect(country(draw(regional({ country: "JP" })))).toBe("US");
    expect(country(draw(regional({ country: "NZ" })))).toBe("US");
    expect(country(draw(regional({ country: "toString" })))).toBe("US");
  });

  it("starts New Zealand on AU sizes and Canada on US sizes", () => {
    const anz = (country: string) =>
      json(
        (c) =>
          c.tables[0].columns.splice(
            1,
            1,
            { id: "eu", kind: "country", country: "EU" },
            { id: "au", kind: "country", country: "AU" },
            { id: "us", kind: "country", country: "US" },
          ),
        { country },
      );
    expect(country(draw(anz("NZ")))).toBe("AU");
    expect(country(draw(anz("CA")))).toBe("US");
    expect(country(draw(anz("CH")))).toBe("EU");
    expect(country(draw(anz("JP")))).toBe("EU");
  });

  it("switches the column and keeps focus on the switch", () => {
    const root = draw(regional());
    document.body.append(root);
    const eu = [...group(root)!.querySelectorAll("button")][2];
    eu.focus();
    eu.click();
    expect(document.activeElement).toBe(eu);
    expect(country(root)).toBe("EU");
    expect(texts(group(root)!, '[aria-pressed="true"]')).toEqual(["EU"]);
    expect(root.querySelector("tbody td")?.textContent).toBe("36–38");
  });

  it("shows a table without that system its first, and a one-system table as is", () => {
    const root = draw(
      json((c) => {
        const [t1] = c.tables;
        t1.columns.splice(2, 0, { id: "eu", kind: "country", country: "EU" });
        c.tables.push(
          { ...t1, id: "t2", columns: [...t1.columns] },
          {
            ...t1,
            id: "t3",
            columns: t1.columns.filter((x) => x !== t1.columns[2]),
          },
        );
        c.tables[1].columns.splice(
          1,
          2,
          { id: "au", kind: "country", country: "AU" },
          { id: "uk", kind: "country", country: "UK" },
        );
      }),
    );
    expect(texts(group(root)!, "button")).toEqual(["US", "UK", "EU", "AU"]);
    [...group(root)!.querySelectorAll("button")][2].click();
    expect(texts(root, "thead th:nth-child(2)")).toEqual(["EU", "AU", "US"]);
  });

  it("isn't there when no table names two systems", () => {
    const root = draw(data());
    expect(group(root)).toBeNull();
    expect(country(root)).toBe("US");
  });

  it("leaves out a merge inside the country columns it hides", () => {
    const c = JSON.parse(regional()).chart;
    c.tables[0].merges = [{ row: "s", col: "uk", rows: 1, cols: 2 }];
    const root = draw(data({ chart: c }));
    expect(texts(root, "tbody tr:first-child > *").slice(0, 3)).toEqual([
      "S",
      "4–6",
      "33–34",
    ]);
    [...group(root)!.querySelectorAll("button")][1].click();
    expect(root.querySelector("tbody td")?.textContent).toBe("8–10");
    expect(root.querySelector("tbody td")?.getAttribute("colspan")).toBe("1");
  });

  it("shows a merge across country columns in whichever is shown", () => {
    const root = draw(
      json((c) => {
        c.tables[0].columns.splice(2, 0, {
          id: "eu",
          kind: "country",
          country: "EU",
        });
        c.tables[0].merges = [{ row: "m", col: "us", rows: 1, cols: 2 }];
        c.words["t1.m.us"] = "One size";
      }),
    );
    const cell = () => root.querySelector("tbody tr:last-child td");
    expect(cell()?.textContent).toBe("One size");
    expect(cell()?.getAttribute("colspan")).toBe("1");
    [...group(root)!.querySelectorAll("button")][1].click();
    expect(cell()?.textContent).toBe("One size");
    expect(texts(root, "tbody tr:last-child > *")).toHaveLength(6);
  });
});

describe("merged and wrapping cells", () => {
  it("spans a merge from its top-left cell and leaves out the cells it covers", () => {
    const root = draw(
      json((c) => {
        c.tables[0].merges = [
          { row: "s", col: "bust", rows: 2, cols: 1 },
          { row: "s", col: "len", rows: 1, cols: 2 },
        ];
      }),
    );
    expect(texts(root, "tbody tr:first-child > *")).toEqual([
      "S",
      "4–6",
      "33–34",
      "110",
      "60",
    ]);
    const [, , bust, , len] = root.querySelectorAll("tbody tr:first-child > *");
    expect([
      bust.getAttribute("rowspan"),
      bust.getAttribute("colspan"),
    ]).toEqual(["2", "1"]);
    expect([len.getAttribute("rowspan"), len.getAttribute("colspan")]).toEqual([
      "1",
      "2",
    ]);
    expect(texts(root, "tbody tr:last-child > *")).toEqual([
      "M",
      "",
      "",
      "",
      "",
    ]);
  });

  it("makes rows merged in the size column one size", () => {
    const root = draw(
      json((c) => {
        c.tables[0].merges = [{ row: "s", col: "size", rows: 2, cols: 1 }];
        c.words["t1.s.size"] = "S/M";
      }),
    );
    expect(root.querySelector("tbody th")?.getAttribute("rowspan")).toBe("2");
    expect(root.querySelectorAll("tbody th")).toHaveLength(1);
    root.querySelector<HTMLElement>("tbody tr:last-child td")!.click();
    expect(root.querySelectorAll(".fitted-on")).toHaveLength(2);
    expect(root.querySelector(".fitted-foot strong")?.textContent).toBe(
      "Selected: S/M",
    );
  });

  it("leaves a merged cell dark while no size it spans is picked", () => {
    const root = draw(
      withChart((c) => {
        delete c.words["t1.m.size"];
        c.tables[0].merges = [{ row: "s", col: "fit", rows: 2, cols: 1 }];
      }),
    );
    expect(root.querySelector(".fitted-lit")).toBeNull();
  });

  it("lights up a cell merged across rows for any size it spans", () => {
    const root = draw(
      withChart((c) => {
        c.tables[0].rows.push({ id: "l", cells: {} });
        c.words["t1.l.size"] = "L";
        c.tables[0].merges = [{ row: "s", col: "fit", rows: 2, cols: 1 }];
      }),
    );
    const fit = root.querySelector("tbody td:last-child")!;
    root.querySelector<HTMLElement>("tbody tr:nth-child(2) th button")!.click();
    expect(fit.classList.contains("fitted-lit")).toBe(true);
    root.querySelector<HTMLElement>("tbody tr:first-child th button")!.click();
    expect(fit.classList.contains("fitted-lit")).toBe(true);
    root.querySelector<HTMLElement>("tbody tr:last-child th button")!.click();
    expect(fit.classList.contains("fitted-lit")).toBe(false);
  });

  it("lets the columns in wrap wrap", () => {
    const root = draw(withChart((c) => (c.tables[0].wrap = ["fit"])));
    expect(root.querySelectorAll(".fitted-wrap")).toHaveLength(3);
    expect(root.querySelector("thead th:last-child")?.className).toBe(
      "fitted-wrap",
    );
  });
});

describe("row select", () => {
  const two = () =>
    json((c) => {
      c.tables.push({ ...c.tables[0], id: "t2" });
      Object.assign(c.words, {
        "t2.title": "Garment",
        "t2.s.size": " s ",
        "t2.m.size": "M",
      });
    });
  const pressed = (root: Element) =>
    [...root.querySelectorAll(".fitted-pick")].map((b) =>
      b.getAttribute("aria-pressed"),
    );

  it("lights up the size in every table and fills the footer", () => {
    const root = draw(two());
    const foot = root.querySelector<HTMLElement>(".fitted-foot")!;
    expect(foot.hidden).toBe(true);
    root.querySelector<HTMLElement>("tbody tr:last-child td")!.click();
    expect(texts(root, ".fitted-on th")).toEqual(["M", "M"]);
    expect(pressed(root)).toEqual(["false", "true", "false", "true"]);
    expect(foot.hidden).toBe(false);
    expect(foot.querySelector("strong")?.textContent).toBe("Selected: M");
    expect(foot.querySelector("strong span")?.textContent).toBe("M");
    // Without a product form there's nothing to select in.
    expect(
      foot.querySelector<HTMLElement>("[data-fitted-select]")?.hidden,
    ).toBe(true);
    // Labels match whatever their case and spacing.
    root.querySelector<HTMLElement>(".fitted-pick")!.click();
    expect(texts(root, ".fitted-on th")).toEqual(["S", " s "]);
  });

  it("keeps the pick, and focus on its button, as the switches redraw", () => {
    const root = draw(data({ units: null }));
    document.body.append(root);
    const s = root.querySelector<HTMLElement>(".fitted-pick")!;
    s.focus();
    s.click();
    expect(document.activeElement).toBe(s);
    root.querySelectorAll<HTMLElement>(".fitted-seg button")[1].click();
    expect(texts(root, ".fitted-on th")).toEqual(["S"]);
    document.body.replaceChildren();
  });

  it("names each row's button with its size, as text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const root = draw(data({ strings: { "t1.s.size": evil } }));
    const pick = root.querySelector(".fitted-pick")!;
    expect(pick.getAttribute("aria-label")).toBe(`Choose size ${evil}`);
    expect(pick.textContent).toBe(evil);
    (pick as HTMLElement).click();
    expect(root.querySelector(".fitted-foot strong")?.textContent).toBe(
      `Selected: ${evil}`,
    );
    expect(root.querySelector("img")).toBeNull();
  });
});

describe("the product form", () => {
  afterEach(() => document.body.replaceChildren());
  // A product section like Dawn's: size controls beside the form, the block
  // after them.
  const page = (controls: string, outside = "") => {
    document.body.innerHTML = `${outside}<div class="shopify-section"><div>${controls}<form action="/cart/add"><input type="hidden" name="id" value="1"></form><div class="fitted-guide"><dialog><div class="fitted-body"></div></dialog></div></div></div>`;
    const dialog = document.querySelector("dialog")!;
    dialog.showModal();
    const { root, sync } = show(
      data(),
      document.querySelector<HTMLElement>(".fitted-body")!,
    );
    const go = root.querySelector<HTMLButtonElement>("[data-fitted-select]")!;
    return { root, sync, dialog, go };
  };
  const radio = (size: string, more = "") =>
    `<input type="radio" name="Size-1" value="${size}" ${more}>`;
  const picked = (root: Element) => texts(root, ".fitted-on th");

  it("opens on the form's size; Select picks another and closes the guide", () => {
    const { root, dialog, go } = page(
      radio("S") + radio("M", "checked") + radio("L"),
    );
    expect(picked(root)).toEqual(["M"]);
    expect([go.hidden, go.textContent]).toEqual([false, "Select M"]);
    root.querySelector<HTMLElement>("tbody td")!.click();
    expect(go.textContent).toBe("Select S");
    const changed = vi.fn();
    document.addEventListener("change", changed);
    go.click();
    document.removeEventListener("change", changed);
    expect(dialog.open).toBe(false);
    expect(
      document.querySelector<HTMLInputElement>('[value="S"]')!.checked,
    ).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("sets a select the way a shopper would", () => {
    const { root, go } = page(
      '<select name="options[Size]"><option>S</option><option selected>M</option></select>',
    );
    expect(picked(root)).toEqual(["M"]);
    const events: string[] = [];
    for (const type of ["input", "change"])
      document.addEventListener(type, () => events.push(type), { once: true });
    root.querySelector<HTMLElement>("tbody td")!.click();
    go.click();
    expect(document.querySelector("select")!.value).toBe("S");
    expect(events).toEqual(["input", "change"]);
  });

  it("skips a select's disabled option", () => {
    const { root, go } = page(
      '<select name="options[Size]"><option selected>S</option><option disabled>M</option></select>',
    );
    root.querySelector<HTMLElement>("tbody tr:last-child td")!.click();
    expect(go.hidden).toBe(true);
  });

  it("offers Select only for a size the form has", () => {
    const { root, go } = page(radio("S", "checked") + radio("M", "disabled"));
    expect([picked(root), go.hidden]).toEqual([["S"], false]);
    root.querySelector<HTMLElement>("tbody tr:last-child td")!.click();
    expect(root.querySelector(".fitted-foot strong")?.textContent).toBe(
      "Selected: M",
    );
    expect(go.hidden).toBe(true);
  });

  it("follows the form when sync runs on the next open", () => {
    const { root, sync } = page(radio("S", "checked") + radio("M"));
    document.querySelector<HTMLInputElement>('[value="M"]')!.click();
    sync();
    expect(picked(root)).toEqual(["M"]);
    // A form showing no size of the chart keeps the pick.
    document.querySelector<HTMLInputElement>('[value="M"]')!.checked = false;
    sync();
    expect(picked(root)).toEqual(["M"]);
  });

  it("never looks past its own section for a product form", () => {
    document.body.innerHTML = `<div class="shopify-section">${radio("S", "checked")}${radio("M")}<form action="/cart/add"></form></div><div class="shopify-section"><div class="fitted-guide"><dialog><div class="fitted-body"></div></dialog></div></div>`;
    const { root } = show(
      data(),
      document.querySelector<HTMLElement>(".fitted-body")!,
    );
    expect(picked(root)).toEqual([]);
    root.querySelector<HTMLElement>("tbody td")!.click();
    expect(
      root.querySelector<HTMLElement>("[data-fitted-select]")!.hidden,
    ).toBe(true);
  });

  it("ignores controls outside the block's section, variant ids and quantities", () => {
    const { root, go } = page(
      '<select name="id"><option value="s">S</option></select><select name="quantity"><option value="m">M</option></select>',
      `<div class="shopify-section">${radio("S", "checked")}</div>`,
    );
    expect(picked(root)).toEqual([]);
    root.querySelector<HTMLElement>("tbody td")!.click();
    expect(go.hidden).toBe(true);
  });
});
