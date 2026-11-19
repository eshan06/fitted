import { describe, expect, it } from "vitest";
import { type ChartInput, validateChart } from "../../models/chart.server";
import {
  addMeasurement,
  addSize,
  blankDraft,
  formatCell,
  parseCell,
  setCell,
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
          "Type a number, or a range like 31–32",
        "content.tables.0.rows.1.cells.bust":
          "Type a number, or a range like 31–32",
      },
    });
  });
});
