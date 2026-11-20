import { describe, expect, it } from "vitest";
import { type ChartInput, validateChart } from "../../models/chart.server";
import {
  addMeasurement,
  addSize,
  blankDraft,
  formatCell,
  cellProblem,
  parseCell,
  problems,
  setCell,
  storedDraft,
  setUnit,
  setWord,
  toDraft,
  toInput,
} from "./model";

const chart = (): ChartInput =>
  validateChart({
    name: "Women's tops",
    template: "tops",
    measureImage: "gid://shopify/MediaImage/7",
    importNote: "Check units",
    content: {
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
          ],
          rows: [
            { id: "xs", cells: { bust: [31, 32] } },
            { id: "s", cells: { bust: [33.5] } },
          ],
        },
        {
          id: "t2",
          columns: [
            { id: "sz", kind: "size" },
            { id: "len", kind: "measure", convert: true },
          ],
          rows: [{ id: "r1", cells: { len: [25] } }],
        },
      ],
      measure: { steps: ["c1"] },
      words: {
        "t1.size": "Size",
        "t1.us": "US size",
        "t1.bust": "Bust",
        "t1.xs.size": "XS",
        "t1.xs.us": "0–2",
        "t1.s.size": "S",
        "t1.note": "Between sizes? Size up.",
        "t2.sz": "Size",
        "t2.len": "Length",
        "t2.r1.sz": "XS",
      },
    },
  });

const input = (d: ReturnType<typeof blankDraft>) => {
  const r = toInput(d);
  if ("fieldErrors" in r) throw new Error(JSON.stringify(r.fieldErrors));
  return r.input;
};

describe("parseCell", () => {
  it.each([
    ["31", [31]],
    [" 31.5 ", [31.5]],
    ["31,5", [31.5]],
    ["31-32", [31, 32]],
    ["31 – 32.5", [31, 32.5]],
    ["31—32", [31, 32]],
    ["32-32", [32]],
  ])("reads %j", (text, cell) => expect(parseCell(text)).toEqual(cell));

  it("reads blank as no value and anything else as invalid", () => {
    expect(parseCell("  ")).toBeNull();
    for (const t of ["abc", "-3", "31-", "31 to 32", "1e3", "31-32-33"])
      expect(parseCell(t)).toBe("invalid");
  });

  it("writes cells back the way the canvas shows them", () => {
    expect(formatCell([31, 32])).toBe("31–32");
    expect(formatCell([33.5])).toBe("33.5");
  });
});

describe("the editor draft", () => {
  it("saves an untouched chart as it was, minus the import note", () => {
    const { importNote, ...rest } = chart();
    expect(importNote).toBe("Check units");
    const saved = input(toDraft(chart(), "ACTIVE"));
    expect(saved).toEqual(rest);
    expect(validateChart(saved)).toEqual(saved);
  });

  it("builds a new chart that passes validation", () => {
    let d = addMeasurement(addSize(blankDraft()));
    const [row] = d.content.tables[0].rows;
    const col = d.content.tables[0].columns[1];
    d = setWord(d, "t1.size", "Size");
    d = setWord(d, `t1.${row.id}.size`, "M");
    d = setWord(d, `t1.${col.id}`, "Waist");
    d = setCell(d, row.id, col.id, "28-29");
    d = setUnit({ ...d, name: " Jeans " }, "cm");
    const saved = input(d);
    expect(validateChart(saved)).toEqual(saved);
    expect(saved).toMatchObject({ name: "Jeans", template: "blank" });
    expect(saved.content.unit).toBe("cm");
    expect(saved.content.tables[0].rows[0].cells).toEqual({
      [col.id]: [28, 29],
    });
  });

  it("gives new sizes and measurements ids no other part of the chart uses", () => {
    // t2 already has r1 and the measuring steps have c1.
    let d = toDraft(chart(), "DRAFT");
    d = addMeasurement(addSize(addSize(d)));
    const t = d.content.tables[0];
    expect(t.rows.map((r) => r.id)).toEqual(["xs", "s", "r2", "r3"]);
    expect(t.columns.at(-1)).toEqual({
      id: "c2",
      kind: "measure",
      convert: true,
    });
  });

  it("keeps edits to the first table only, leaving other tables alone", () => {
    let d = toDraft(chart(), "ACTIVE");
    d = setCell(d, "xs", "bust", "30–31");
    d = setCell(d, "s", "bust", "");
    const saved = input(d);
    expect(saved.content.tables[0].rows).toEqual([
      { id: "xs", cells: { bust: [30, 31] } },
      { id: "s", cells: {} },
    ]);
    expect(saved.content.tables[1]).toEqual(chart().content.tables[1]);
  });

  it("names sizes by the table's own size column id", () => {
    // t2's size column is "sz", not "size".
    const c = chart();
    const d = toDraft(
      { ...c, content: { ...c.content, tables: [c.content.tables[1]] } },
      "DRAFT",
    );
    expect(toInput(d)).toHaveProperty("input");
    expect(toInput(setWord(d, "t2.r1.sz", ""))).toEqual({
      fieldErrors: { "content.words.t2.r1.sz": "Name this size" },
    });
  });

  it("stops adding sizes at 60 and columns at 20", () => {
    let d = blankDraft();
    for (let i = 0; i < 70; i++) d = addMeasurement(addSize(d));
    expect(d.content.tables[0].rows).toHaveLength(60);
    expect(d.content.tables[0].columns).toHaveLength(20);
  });

  it("leaves emptied words out instead of saving them blank", () => {
    const d = setWord(toDraft(chart(), "ACTIVE"), "t1.note", "  ");
    expect(input(d).content.words).not.toHaveProperty(["t1.note"]);
  });

  it("names every problem by the path validateChart uses", () => {
    expect(toInput(blankDraft())).toEqual({
      fieldErrors: {
        name: "Give the chart a name",
        "content.tables.0.rows": "Add at least one size",
      },
    });
    let d = addMeasurement(addSize(toDraft(chart(), "ACTIVE")));
    d = setCell(d, "xs", "bust", "32-31");
    d = setCell(d, "s", "bust", "big");
    expect(toInput({ ...d, name: " " })).toEqual({
      fieldErrors: {
        name: "Give the chart a name",
        "content.words.t1.c2": "Name this measurement",
        "content.words.t1.r2.size": "Name this size",
        "content.tables.0.rows.0.cells.bust":
          "Put the smaller number first, like 31–32.",
        "content.tables.0.rows.1.cells.bust":
          "Type a number, or a range like 31–32.",
      },
    });
  });
});

describe("cell problems, in the Editor board's words", () => {
  it.each([
    [
      "35–",
      "is missing the second number",
      "Add the second number, like 35–36, or delete the dash.",
    ],
    [
      "37.5 -",
      "is missing the second number",
      "Add the second number, like 37.5–38.5, or delete the dash.",
    ],
    [
      "42–40.5",
      "runs from high to low",
      "Put the smaller number first, like 40.5–42.",
    ],
    ["0", "is 0", "Use a number above 0, or clear the cell."],
    ["0–2", "is 0", "Use a number above 0, or clear the cell."],
    [
      "10000",
      "is 10,000 or more",
      "Use a number below 10,000, or clear the cell.",
    ],
    ["big", "isn't a number", "Type a number, or a range like 31–32."],
  ])("%j %s", (text, short, long) =>
    expect(cellProblem(text)).toEqual({ short, long }),
  );

  it("finds nothing wrong with a blank cell, a number or a range", () => {
    for (const t of ["", " ", "31", "31,5", "31–32", "32–32"])
      expect(cellProblem(t)).toBeNull();
  });

  it("names each problem by size and column, with the input it links to", () => {
    let d = addMeasurement(addSize(toDraft(chart(), "ACTIVE")));
    d = setCell(d, "xs", "bust", "32-31");
    const r = toInput({ ...d, name: "" });
    if (!("fieldErrors" in r)) throw new Error("expected errors");
    expect(problems(d, r.fieldErrors)).toEqual([
      { id: "name", where: "Chart name", long: "Give the chart a name" },
      {
        id: "cell-h-c2",
        where: "Column 4 name",
        long: "Name this measurement",
      },
      {
        id: "cell-xs-bust",
        where: "XS, Bust",
        short: "runs from high to low",
        long: "Put the smaller number first, like 31–32.",
      },
      { id: "cell-r2-size", where: "Size 3", long: "Name this size" },
    ]);
  });

  it("names the server's own problems too, and anything else by its message", () => {
    const d = toDraft(chart(), "ACTIVE");
    expect(
      problems(d, {
        "content.words.t1.xs.us": "Too long",
        "content.tables.0.rows.1.cells.bust": "Use a number above 0",
        "content.tables.1.rows.0.cells.len": "Use a number above 0",
      }),
    ).toEqual([
      { id: "cell-xs-us", where: "XS, US size", long: "Too long" },
      {
        id: "cell-s-bust",
        where: "S, Bust",
        short: undefined,
        long: "Use a number above 0",
      },
      { where: "", long: "Use a number above 0" },
    ]);
  });
});

describe("storedDraft", () => {
  const raw = () => {
    const c = chart();
    c.content.tables[0].rows[0].cells.bust = [32, 31];
    c.content.tables[0].rows[1].cells.bust = [0];
    return { ...c, content: JSON.parse(JSON.stringify(c.content)) };
  };

  it("opens a stored chart that fails the checks with its bad values as text", () => {
    const d = storedDraft(raw(), "ACTIVE", {
      "content.tables.0.rows.0.cells.bust": "Use a range from low to high",
      "content.words.t1.xs.us": "Too long",
      name: "Too long",
    })!;
    expect(d.cells).toMatchObject({ "xs.bust": "32–31", "s.bust": "0" });
    expect(d.name).toBe("Women's tops");
    const r = toInput(d);
    expect("fieldErrors" in r && Object.keys(r.fieldErrors)).toEqual([
      "content.tables.0.rows.0.cells.bust",
      "content.tables.0.rows.1.cells.bust",
    ]);
  });

  it.each([
    ["no content", { name: "X", template: "tops" }],
    ["an unknown template", { ...raw(), template: "hats" }],
    ["no tables", { ...raw(), content: { ...raw().content, tables: [] } }],
    [
      "a row without cells",
      {
        ...raw(),
        content: {
          ...raw().content,
          tables: [
            { id: "t1", columns: [{ id: "size" }], rows: [{ id: "a" }] },
          ],
        },
      },
    ],
    [
      "words that aren't text",
      { ...raw(), content: { ...raw().content, words: { a: 1 } } },
    ],
  ])("gives up on %s, which the table can't draw", (_, r) => {
    expect(storedDraft(r, "DRAFT", {})).toBeNull();
  });

  it.each([
    "content.v",
    "content.roundTo",
    "content.tables.1.rows.0.cells.len",
  ])("gives up when a finding (%s) is outside what the editor shows", (key) => {
    expect(storedDraft(raw(), "DRAFT", { [key]: "Wrong" })).toBeNull();
  });

  it.each(["content.unit", "content.words.t1.note"])(
    "opens a chart whose finding (%s) the units or the note can fix",
    (key) => {
      expect(storedDraft(raw(), "DRAFT", { [key]: "Wrong" })).not.toBeNull();
    },
  );
});
