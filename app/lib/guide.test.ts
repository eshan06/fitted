// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseGuide, render } from "./guide";

// Loose on purpose: the tests write invalid charts into it.
type Fixture = {
  v: unknown;
  unit: unknown;
  roundTo: unknown;
  tables: {
    id: string;
    columns: unknown[];
    rows: { id: string; cells: Record<string, unknown> }[];
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
const data = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    chart: chart(),
    strings: {},
    units: null,
    country: "US",
    locale: "en",
    ...over,
  });
const withChart = (edit: (c: ReturnType<typeof chart>) => void) => {
  const c = chart();
  edit(c);
  return data({ chart: c });
};
const draw = (json: string) => {
  const g = parseGuide(json);
  if (!g) throw new Error("expected a guide");
  const root = document.createElement("div");
  root.dataset.tChart = "Size chart";
  render(root, g);
  return root;
};
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
  ])("refuses %s, so nothing renders", (_, json) => {
    expect(parseGuide(json)).toBeNull();
  });
});

describe("render", () => {
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
