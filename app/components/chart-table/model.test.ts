import { describe, expect, it } from "vitest";
import { type ChartInput, validateChart } from "../../models/chart.server";
import {
  addMeasurement,
  addSize,
  blankDraft,
  canMerge,
  merge,
  merges,
  merging,
  setMeasure,
  setRoundTo,
  toggleWrap,
  unmerge,
  dropped,
  fitOnly,
  formatCell,
  cellProblem,
  parseCell,
  problems,
  removal,
  remove,
  removeErrors,
  setCell,
  storedDraft,
  setUnit,
  setWord,
  toDraft,
  toInput,
  readPaste,
  found,
  replaceTable,
  regions,
  setRegions,
  canAll,
  canUsOnly,
  addStep,
  removeStep,
  MAX_STEPS,
  MAX_TABLES,
  addTable,
  canRemoveTable,
  cloneTable,
  focus,
  focusErrors,
  measuresOf,
  removeTable,
  removeTableErrors,
  setVideo,
  tableTitle,
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
      {
        id: "name",
        where: "Chart name",
        long: "Give the chart a name",
        table: 0,
      },
      {
        id: "cell-h-c2",
        where: "Column 4 name",
        long: "Name this measurement",
        table: 0,
      },
      {
        id: "cell-xs-bust",
        where: "XS, Bust",
        short: "runs from high to low",
        long: "Put the smaller number first, like 31–32.",
        table: 0,
      },
      {
        id: "cell-r2-size",
        where: "Size 3",
        long: "Name this size",
        table: 0,
      },
    ]);
  });

  it("checks every table, and names a later table's problems in it", () => {
    let d = toDraft(chart(), "ACTIVE");
    d = setCell(d, "r1", "len", "0");
    d = setWord(d, "t2.len", "");
    const r = toInput(d);
    if (!("fieldErrors" in r)) throw new Error("expected errors");
    expect(r.fieldErrors).toEqual({
      "content.words.t2.len": "Name this measurement",
      "content.tables.1.rows.0.cells.len":
        "Use a number above 0, or clear the cell.",
    });
    expect(problems(d, r.fieldErrors)).toEqual([
      {
        id: "cell-h-len",
        where: "Column 2 name",
        long: "Name this measurement",
        table: 1,
      },
      {
        id: "cell-r1-len",
        where: "XS, Measurement",
        short: "is 0",
        long: "Use a number above 0, or clear the cell.",
        table: 1,
      },
    ]);
  });

  it("names the server's own problems too, and anything else by its message", () => {
    const d = toDraft(chart(), "ACTIVE");
    expect(
      problems(d, {
        "content.words.t1.xs.us": "Too long",
        "content.tables.0.rows.1.cells.bust": "Use a number above 0",
        "content.tables.1.rows.0.cells.len": "Use a number above 0",
        "content.tables.5.rows": "Unknown",
        "content.videoUrl": "Use an https link from YouTube or Vimeo.",
      }),
    ).toEqual([
      { id: "cell-xs-us", where: "XS, US size", long: "Too long", table: 0 },
      {
        id: "cell-s-bust",
        where: "S, Bust",
        short: undefined,
        long: "Use a number above 0",
        table: 0,
      },
      {
        id: "cell-r1-len",
        where: "XS, Length",
        short: undefined,
        long: "Use a number above 0",
        table: 1,
      },
      { where: "", long: "Unknown", table: 0 },
      {
        id: "video",
        where: "Fit video",
        long: "Use an https link from YouTube or Vimeo.",
        table: 0,
      },
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

  it.each(["content.v", "content.roundTo", "content.tables.1.merges"])(
    "gives up when a finding (%s) is outside what the editor shows",
    (key) => {
      expect(storedDraft(raw(), "DRAFT", { [key]: "Wrong" })).toBeNull();
    },
  );

  it("opens a later table's bad values and dropped numbers, as the first table's", () => {
    const r = raw();
    r.content.tables[1].rows[0].cells.len = [0];
    r.content.tables[1].rows[0].cells.sz = [6];
    const d = storedDraft(r, "DRAFT", {
      "content.tables.1.rows.0.cells.len": "Use a number above 0",
      "content.words.t2.title": "Too long",
    })!;
    expect(d.cells["r1.len"]).toBe("0");
    const errs = toInput(d);
    expect("fieldErrors" in errs && Object.keys(errs.fieldErrors)).toContain(
      "content.tables.1.rows.0.cells.len",
    );
    expect(dropped(d)).toEqual([
      expect.objectContaining({
        col: "sz",
        cells: ["r1.sz"],
        heading: "Saving drops 1 value in Size",
      }),
    ]);
    // A later table's column it doesn't have still can't be named.
    r.content.tables[1].rows[0].cells.bust = [30];
    expect(storedDraft(r, "DRAFT", {})).toBeNull();
  });

  // A stored cell outside a measurement that dropped() couldn't name.
  const cellAt = (col: string, cell: unknown) => {
    const r = raw();
    r.content.tables[0].rows[1].cells[col] = cell;
    return r;
  };
  it.each([
    ["a column the table doesn't have", cellAt("hips", [30])],
    ["text in a country column", cellAt("us", "4")],
    ["no numbers in a country column", cellAt("us", [])],
    ["three numbers in a country column", cellAt("us", [1, 2, 3])],
  ])("gives up on a cell in %s, which a save would drop unsaid", (_, r) => {
    expect(storedDraft(r, "DRAFT", {})).toBeNull();
  });

  it("names the stored numbers a save drops outside the measurements, until retyped", () => {
    const r = cellAt("us", [4, 6]);
    r.content.tables[0].rows[0].cells.us = [0, 2];
    r.content.tables[0].rows[0].cells.size = [1];
    const d = storedDraft(r, "DRAFT", {})!;
    // XS already says 0–2 in words, so only S's 4–6 and XS's size number go.
    expect(dropped(d)).toEqual([
      {
        col: "size",
        cells: ["xs.size"],
        heading: "Saving drops 1 value in Size",
        text: "They were added outside Fitted as numbers, which this column can't hold: 1 (XS).",
        fix: "Type it in again to keep it.",
      },
      expect.objectContaining({
        cells: ["s.us"],
        heading: "Saving drops 1 value in US size",
      }),
    ]);
    const typed = setWord(setWord(d, "t1.s.us", " 4 - 6"), "t1.xs.size", "1");
    expect(dropped(typed)).toEqual([]);
    expect(removal(d, { col: "us" })).toMatchObject({
      heading: "Remove the US size column?",
      label: "Remove column",
    });
    expect(removal(d, { col: "bust" }).label).toBe("Remove measurement");
    // Removing a size names its stored numbers too, since they go with it.
    expect(removal(d, { row: "s" }).text).toBe(
      "Saving removes S's values: US size 4–6 and Bust 0.",
    );
  });

  it.each(["content.unit", "content.words.t1.note"])(
    "opens a chart whose finding (%s) the units or the note can fix",
    (key) => {
      expect(storedDraft(raw(), "DRAFT", { [key]: "Wrong" })).not.toBeNull();
    },
  );
});

describe("removing a size or a measurement", () => {
  it("lists the values a size takes with it, or none for an empty one", () => {
    const d = toDraft(chart(), "DRAFT");
    expect(removal(d, { row: "xs" })).toEqual({
      heading: "Remove size XS?",
      label: "Remove size",
      text: "Saving removes XS's values: US size 0–2 and Bust 31–32.",
    });
    const added = addSize(d);
    const row = added.content.tables[0].rows.at(-1)!.id;
    expect(removal(added, { row }).text).toBeNull();
    // A name of only spaces reads as no name.
    const typed = setWord(
      setCell(added, row, "bust", "40"),
      `t1.${row}.size`,
      " ",
    );
    expect(removal(typed, { row })).toMatchObject({
      heading: "Remove size 3?",
      text: "Saving removes Size 3's values: Bust 40.",
    });
  });

  it("names the sizes a measurement leaves, first to last", () => {
    const d = toDraft(chart(), "DRAFT");
    expect(removal(d, { col: "bust" })).toEqual({
      heading: "Remove the Bust measurement?",
      label: "Remove measurement",
      text: "Saving removes Bust from all 2 sizes, 31–32 (XS) to 33.5 (S). Shoppers won't see a Bust column.",
    });
    expect(removal(setCell(d, "s", "bust", ""), { col: "bust" }).text).toBe(
      "Saving removes Bust from 1 size, 31–32 (XS). Shoppers won't see a Bust column.",
    );
    const added = addMeasurement(d);
    const col = added.content.tables[0].columns.at(-1)!.id;
    expect(removal(added, { col }).text).toBeNull();
  });

  it("takes a size and a column out of words, cells, merges, wrap and the fit finder, so the chart still passes", () => {
    const c = chart();
    const t = c.content.tables[0];
    t.columns.push({ id: "waist", kind: "measure", convert: true });
    t.rows.push({ id: "m", cells: { bust: [35], waist: [28] } });
    t.merges = [
      { row: "xs", col: "us", rows: 2, cols: 1 },
      { row: "m", col: "waist", rows: 1, cols: 1 },
      { row: "m", col: "us", rows: 1, cols: 2 },
    ];
    t.wrap = ["bust", "waist"];
    Object.assign(c.content.words, {
      "t1.waist": "Waist",
      "t1.m.size": "M",
      "t1.m.us": "8",
      "fit.qb": "Bust",
      "fit.qw": "Waist",
      "fit.qc": "Shape",
      "fit.qc.o1": "Slim",
    });
    c.content.fit = {
      table: "t1",
      stretch: "none",
      ease: { bust: 1, waist: 1 },
      questions: [
        { id: "qb", kind: "measure", col: "bust", optional: false },
        { id: "qw", kind: "measure", col: "waist", optional: true },
        {
          id: "qc",
          kind: "choice",
          options: [{ id: "o1", rows: ["xs", "s"] }],
        },
      ],
    };
    const d = toDraft(validateChart(c), "DRAFT");
    const out = remove(remove(d, { col: "waist" }), { row: "s" });
    const saved = validateChart(input(out));
    const t1 = saved.content.tables[0];
    expect(t1.columns.map((x) => x.id)).toEqual(["size", "us", "bust"]);
    expect(t1.rows.map((r) => r.id)).toEqual(["xs", "m"]);
    // Only the merges that span a removed size or column go.
    expect(t1.merges).toEqual([{ row: "m", col: "us", rows: 1, cols: 2 }]);
    expect(t1.wrap).toEqual(["bust"]);
    expect(saved.content.fit).toMatchObject({
      ease: { bust: 1 },
      questions: [{ id: "qb" }, { id: "qc", options: [{ rows: ["xs"] }] }],
    });
    expect(saved.content.words).not.toHaveProperty(["t1.waist"]);
    expect(saved.content.words).not.toHaveProperty(["t1.s.size"]);
    expect(saved.content.words).not.toHaveProperty(["fit.qw"]);
    expect(out.cells).not.toHaveProperty(["m.waist"]);
    // The other table rides along untouched.
    expect(saved.content.tables[1]).toEqual(chart().content.tables[1]);
  });

  it("keeps only the column the fit finder's measure questions all ask", () => {
    const c = chart();
    c.content.tables[0].columns.push({
      id: "waist",
      kind: "measure",
      convert: true,
    });
    Object.assign(c.content.words, { "t1.waist": "Waist", "fit.qb": "Bust" });
    const fit = (questions: NonNullable<typeof c.content.fit>["questions"]) =>
      toDraft(
        {
          ...c,
          content: {
            ...c.content,
            fit: { table: "t1", stretch: "none", ease: {}, questions },
          },
        },
        "DRAFT",
      );
    const bust = {
      id: "qb",
      kind: "measure",
      col: "bust",
      optional: false,
    } as const;
    const usual = { id: "qu", kind: "usual_size" } as const;
    expect(fitOnly(fit([bust, usual]), "bust")).toBe(true);
    expect(fitOnly(fit([bust, usual]), "waist")).toBe(false);
    expect(
      fitOnly(fit([bust, { ...bust, id: "qw", col: "waist" }]), "bust"),
    ).toBe(false);
    expect(fitOnly(fit([usual]), "bust")).toBe(false);
    expect(fitOnly(toDraft(c, "DRAFT"), "bust")).toBe(false);
    // A size is never the fit finder's measurement.
    expect(fitOnly(fit([bust]), undefined)).toBe(false);
  });

  it("drops the removed size's or column's findings and moves the later sizes' up", () => {
    const d = toDraft(chart(), "DRAFT");
    const errors = {
      "content.tables.0.rows.0.cells.bust": "a",
      "content.tables.0.rows.1.cells.bust": "b",
      "content.tables.0.rows.1.cells.us": "c",
      "content.words.t1.xs.us": "d",
      "content.words.t1.bust": "e",
      name: "f",
    };
    expect(removeErrors(d, { row: "xs" }, errors)).toEqual({
      "content.tables.0.rows.0.cells.bust": "b",
      "content.tables.0.rows.0.cells.us": "c",
      "content.words.t1.bust": "e",
      name: "f",
    });
    expect(removeErrors(d, { col: "bust" }, errors)).toEqual({
      "content.tables.0.rows.1.cells.us": "c",
      "content.words.t1.xs.us": "d",
      name: "f",
    });
  });
});

describe("table tools", () => {
  // Women's tops with a third size, M, and a Fit text column.
  const fitted = () => {
    let d = addSize(toDraft(chart(), "DRAFT"));
    const t = d.content.tables[0];
    d = {
      ...d,
      content: {
        ...d.content,
        tables: [
          { ...t, columns: [...t.columns, { id: "fit", kind: "text" }] },
          ...d.content.tables.slice(1),
        ],
      },
    };
    for (const [k, v] of Object.entries({
      "t1.fit": "Fit",
      "t1.r2.size": "M",
      "t1.xs.fit": "Relaxed",
      "t1.r2.fit": "Regular",
    }))
      d = setWord(d, k, v);
    return setCell(d, "r2", "bust", "35–36");
  };

  it("names the value a merge keeps and the ones it removes", () => {
    const d = fitted();
    expect(merging(d, { col: "fit", a: 0, b: 2 })).toEqual({
      heading: "Merge 3 cells in Fit?",
      label: "Merge cells",
      text: "The merged cell keeps XS's value, Relaxed. Saving removes the other 1: Regular (M).",
    });
    expect(merging(d, { col: "bust", a: 0, b: 2 }).text).toBe(
      "The merged cell keeps XS's value, 31–32. Saving removes the other 2: 33.5 (S) and 35–36 (M).",
    );
    // Only one value: it merges straight away.
    expect(merging(d, { col: "fit", a: 1, b: 2 }).text).toBeNull();
  });

  it("merges down a column, keeping the first value on top, and the save passes the checks", () => {
    const d = merge(fitted(), { col: "fit", a: 1, b: 2 });
    const saved = validateChart(input(d)).content;
    expect(saved.tables[0].merges).toEqual([
      { row: "s", col: "fit", rows: 2, cols: 1 },
    ]);
    expect(saved.words["t1.s.fit"]).toBe("Regular");
    expect(saved.words).not.toHaveProperty(["t1.r2.fit"]);
    // A measurement's covered numbers go too.
    const m = merge(fitted(), { col: "bust", a: 1, b: 2 });
    expect(input(m).content.tables[0].rows.map((r) => r.cells)).toEqual([
      { bust: [31, 32] },
      { bust: [33.5] },
      {},
    ]);
    expect(unmerge(m, "s", "bust").content.tables[0].merges).toEqual([]);
  });

  it("leaves words outside the first table alone when merging", () => {
    const d = setWord(fitted(), "t2.xs.fit", "Kept");
    const m = merge(d, { col: "fit", a: 0, b: 1 });
    expect(m.content.words["t2.xs.fit"]).toBe("Kept");
    expect(m.content.words["t1.xs.fit"]).toBe("Relaxed");
    expect(m.content.words).not.toHaveProperty(["t1.s.fit"]);
  });

  it("merges two or more cells that aren't merged yet", () => {
    const d = merge(fitted(), { col: "fit", a: 0, b: 1 });
    expect(canMerge(fitted(), { col: "fit", a: 1, b: 1 })).toBe(false);
    expect(canMerge(d, { col: "fit", a: 1, b: 2 })).toBe(false);
    expect(canMerge(d, { col: "bust", a: 0, b: 2 })).toBe(true);
    expect(merges(d)).toEqual([
      { row: "xs", col: "fit", rows: 2, cols: 1, r0: 0, c0: 3 },
    ]);
  });

  it("sets wrap, rounding and a measurement's unit and conversion", () => {
    let d = toggleWrap(fitted(), "fit");
    d = setMeasure(setRoundTo(d, 1), "bust", { unit: "cm", convert: false });
    const c = validateChart(input(d)).content;
    expect(c.roundTo).toBe(1);
    expect(c.tables[0].wrap).toEqual(["fit"]);
    expect(c.tables[0].columns[2]).toEqual({
      id: "bust",
      kind: "measure",
      unit: "cm",
      convert: false,
    });
    // Not a measurement: nothing changes.
    expect(setMeasure(d, "fit", { convert: false })).toEqual(d);
    expect(toggleWrap(d, "fit").content.tables[0].wrap).toEqual([]);
  });
});

describe("Paste whole chart", () => {
  const sheet = [
    "Size\tBust\tWaist\tHips",
    "XXS\t29–30\t22–23\t32–33",
    "XS\t31–32\t24–25\t34–35",
    "S\t33–34\t26–27\t36–37",
  ].join("\n");
  const pasted = (text: string) => {
    const p = readPaste(text);
    if (!p) throw new Error("no table");
    return p;
  };

  it("reads a spreadsheet's rows and tabs, and names what it found", () => {
    const p = pasted(sheet);
    expect(p.head).toEqual(["Size", "Bust", "Waist", "Hips"]);
    expect(p.rows[2]).toEqual(["S", "33–34", "26–27", "36–37"]);
    expect(p.columns.map((c) => c.kind)).toEqual([
      "size",
      "measure",
      "measure",
      "measure",
    ]);
    expect(found(p)).toBe(
      "Found 3 sizes and 3 measurements: Bust, Waist and Hips",
    );
    expect(found(pasted("Size\tBust\nM\t35"))).toBe(
      "Found 1 size and 1 measurement: Bust",
    );
  });

  it("takes a web page's copy: line ends, stray spaces, blank lines and padding columns", () => {
    const p = pasted(
      "\r\n\tSize \t Bust (cm)\t\t\u00a0Fit\t\r\n\tXS\t 80 \t\tRelaxed\r\n\t\t\t\t\r\n\tS\t84-88\t\tRegular\r",
    );
    expect(p.head).toEqual(["Size", "Bust", "Fit"]);
    expect(p.rows).toEqual([
      ["XS", "80", "Relaxed"],
      ["S", "84-88", "Regular"],
    ]);
    expect(p.columns).toEqual([
      { id: "", kind: "size" },
      { id: "", kind: "measure", unit: "cm", convert: true },
      { id: "", kind: "text" },
    ]);
  });

  it("reads country columns and a unit at a label's end", () => {
    const p = pasted(
      "Size\tUS\tUK size\tEU\tWaist in\tLength (inches)\nS\t4\t8\t36\t26\t25",
    );
    expect(p.columns.slice(1)).toEqual([
      { id: "", kind: "country", country: "US" },
      { id: "", kind: "country", country: "UK" },
      { id: "", kind: "country", country: "EU" },
      { id: "", kind: "measure", unit: "in", convert: true },
      { id: "", kind: "measure", unit: "in", convert: true },
    ]);
    expect(p.head.slice(4)).toEqual(["Waist", "Length"]);
    expect(found(p)).toBe("Found 1 size and 2 measurements: Waist and Length");
  });

  it("never reads a size system, an age or a unit it can't hold as a length", () => {
    const p = pasted(
      "Size\tIT\tAge\tWeight (kg)\tDiameter (mm)\tEU Bust (cm)\tFit\nS\t40\t2-3\t60\t12\t86\t1\nM\t42\t4-5\t65\t14\t90\tSlim\nL\t44\t6-7\t70\t16\t94\tRelaxed",
    );
    expect(p.columns.slice(1)).toEqual([
      { id: "", kind: "text" },
      { id: "", kind: "text" },
      { id: "", kind: "measure", unit: "kg", convert: true },
      { id: "", kind: "text" },
      { id: "", kind: "measure", unit: "cm", convert: true },
      // Mostly words is text.
      { id: "", kind: "text" },
    ]);
    const lb = pasted(
      "Size\tWeight lbs\tBust\nS\t130\t-\nM\t140\t–\nL\t150\t36",
    );
    expect(lb.columns.slice(1)).toEqual([
      { id: "", kind: "measure", unit: "lb", convert: true },
      { id: "", kind: "measure", convert: true },
    ]);
    expect(lb.rows[0]).toEqual(["S", "130", ""]);
    expect(p.head.slice(3)).toEqual([
      "Weight",
      "Diameter (mm)",
      "EU Bust",
      "Fit",
    ]);
  });

  it("finds no table in prose, one line, or one column", () => {
    for (const t of [
      "",
      "  \n \n",
      "Our autumn tops run a little small through the shoulders.\nSize up if you're between sizes.",
      "Size\tBust\tWaist",
      "Size\nXS\nS",
    ])
      expect(readPaste(t)).toBeNull();
  });

  it("reads a huge hostile paste in linear time", () => {
    const start = performance.now();
    readPaste(`Size\t${"(".repeat(50000)}in\n${"9\t".repeat(50000)}`);
    readPaste(`${" ".repeat(200000)}\n${"US".repeat(100000)}\tx`);
    // A wide header over many short rows costs each row only its own cells.
    const wide = readPaste(
      `${"h\t".repeat(100000)}\n${"S\t1\n".repeat(100000)}`,
    );
    expect(wide!.rows[0]).toEqual(["S", "1"]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("fills a short row's missing cells as empty", () => {
    const next = replaceTable(
      blankDraft(),
      pasted("Size\tBust\tWaist\nS\t33\nM\t35\t28"),
    );
    expect(next.cells).toEqual({
      "r1.c1": "33",
      "r1.c2": "",
      "r2.c1": "35",
      "r2.c2": "28",
    });
  });

  it("keeps a measurement's unit and conversion when the paste names none", () => {
    const d = setMeasure(toDraft(chart(), "DRAFT"), "bust", {
      unit: "cm",
      convert: false,
    });
    const plain = replaceTable(d, pasted("Size\tBust\nXS\t80"));
    expect(plain.content.tables[0].columns[1]).toEqual({
      id: "bust",
      kind: "measure",
      unit: "cm",
      convert: false,
    });
    const named = replaceTable(d, pasted("Size\tBust (in)\nXS\t31"));
    expect(named.content.tables[0].columns[1]).toEqual({
      id: "bust",
      kind: "measure",
      unit: "in",
      convert: true,
    });
  });

  it("replaces the table, keeps its note, and marks the cells it can't read", () => {
    const d = toDraft(chart(), "DRAFT");
    const next = replaceTable(
      d,
      pasted("Size\tBust\tWaist\nXS\t31–32\t24\nM\tabout 35\t28"),
    );
    const t = next.content.tables[0];
    expect(t.id).toBe("t1");
    // XS and Bust are named as before, so they keep their ids.
    expect(t.rows.map((r) => r.id)).toEqual(["xs", "r2"]);
    expect(t.columns.map((c) => c.id)).toEqual(["size", "bust", "c2"]);
    expect(next.content.words["t1.note"]).toBe("Between sizes? Size up.");
    expect(next.content.words).not.toHaveProperty(["t1.us"]);
    expect(next.content.words).not.toHaveProperty(["t1.s.size"]);
    // The second table rides along.
    expect(next.content.tables[1]).toEqual(chart().content.tables[1]);
    const r = toInput(next);
    expect("fieldErrors" in r && r.fieldErrors).toEqual({
      "content.tables.0.rows.1.cells.bust":
        "Type a number, or a range like 31–32.",
    });
    const fixed = validateChart(
      input(setCell(next, "r2", "bust", "35")),
    ).content;
    expect(fixed.tables[0].rows).toEqual([
      { id: "xs", cells: { bust: [31, 32], c2: [24] } },
      { id: "r2", cells: { bust: [35], c2: [28] } },
    ]);
    expect(fixed.words["t1.c2"]).toBe("Waist");
  });

  it("keeps the fit finder's columns and sizes by name, and its only measurement when the paste lacks it", () => {
    const c = chart();
    c.content.tables[0].merges = [{ row: "xs", col: "us", rows: 2, cols: 1 }];
    c.content.tables[0].wrap = ["us", "bust"];
    c.content.fit = {
      table: "t1",
      stretch: "none",
      ease: { bust: 1 },
      questions: [
        { id: "qb", kind: "measure", col: "bust", optional: false },
        {
          id: "qf",
          kind: "choice",
          options: [{ id: "a", rows: ["xs", "s"] }],
        },
      ],
    };
    Object.assign(c.content.words, { "fit.qb": "Bust", "fit.qf": "Fit" });
    const d = toDraft(validateChart(c), "DRAFT");
    // Renamed: the fit finder's Bust stays, at the end, with XS's value.
    const kept = replaceTable(d, pasted("Size\tChest\nxs\t30\nL\t40"));
    const k = validateChart(input(kept)).content;
    expect(k.tables[0].columns.map((x) => x.id)).toEqual([
      "size",
      "c2",
      "bust",
    ]);
    expect(k.tables[0].rows[0].cells).toEqual({ c2: [30], bust: [31, 32] });
    expect(k.tables[0].merges).toBeUndefined();
    expect(k.tables[0].wrap).toEqual(["bust"]);
    expect(k.fit?.questions[1]).toEqual({
      id: "qf",
      kind: "choice",
      options: [{ id: "a", rows: ["xs"] }],
    });
    // Named as before: the fit finder asks the pasted column.
    const same = validateChart(
      input(replaceTable(d, pasted("Size\tBUST\nXS\t30\nS\t34"))),
    ).content;
    expect(same.tables[0].columns.map((x) => x.id)).toEqual(["size", "bust"]);
    expect(same.fit?.ease).toEqual({ bust: 1 });
  });

  it("fills a blank chart", () => {
    const next = replaceTable(blankDraft(), pasted(sheet));
    const c = validateChart({ ...input({ ...next, name: "Tops" }) }).content;
    expect(c.tables[0].rows).toHaveLength(3);
    expect(c.words["t1.r1.size"]).toBe("XXS");
    expect(c.words["t1.c3"]).toBe("Hips");
  });
});

describe("Country sizes", () => {
  const usOnly = () => toDraft(chart(), "DRAFT");

  it("reads US only until two systems are named, then adds the missing ones after the last", () => {
    const d = usOnly();
    expect(regions(d)).toBe("us");
    const all = setRegions(d, "all");
    expect(regions(all)).toBe("all");
    const c = validateChart(input(all)).content;
    expect(c.tables[0].columns.map((x) => x.id)).toEqual([
      "size",
      "us",
      // c1 is a How to measure step's.
      "c2",
      "c3",
      "c4",
      "bust",
    ]);
    expect(["c2", "c3", "c4"].map((id) => c.words[`t1.${id}`])).toEqual([
      "UK size",
      "EU size",
      "AU size",
    ]);
    // No country column yet: all four go after the sizes.
    const none = remove(d, { col: "us" });
    expect(
      setRegions(none, "all").content.tables[0].columns.map((x) => x.kind),
    ).toEqual(["size", "country", "country", "country", "country", "measure"]);
  });

  it("takes out empty UK, EU and AU columns for US only, and keeps or adds a US one", () => {
    const all = setRegions(usOnly(), "all");
    expect(canUsOnly(all)).toBe(true);
    const back = setRegions(all, "us");
    expect(back.content.tables[0].columns.map((x) => x.id)).toEqual([
      "size",
      "us",
      "bust",
    ]);
    expect(back.content.words["t1.xs.us"]).toBe("0–2");
    // Without a US column, one takes their place.
    const noUs = remove(all, { col: "us" });
    const added = setRegions(noUs, "us").content;
    expect(added.tables[0].columns.map((x) => x.kind)).toEqual([
      "size",
      "country",
      "measure",
    ]);
    expect(added.words[`t1.${added.tables[0].columns[1].id}`]).toBe("US size");
  });

  it("widens a merge the added columns land inside, so it keeps its cells", () => {
    const c = chart();
    c.content.tables[0].merges = [
      { row: "xs", col: "us", rows: 1, cols: 2 },
      { row: "s", col: "us", rows: 1, cols: 1 },
    ];
    const all = setRegions(toDraft(validateChart(c), "DRAFT"), "all");
    // The first still ends on Bust; the second ends before the new columns.
    expect(all.content.tables[0].merges).toEqual([
      { row: "xs", col: "us", rows: 1, cols: 5 },
      { row: "s", col: "us", rows: 1, cols: 1 },
    ]);
    expect(() => validateChart(input(all))).not.toThrow();
  });

  it("keeps US only greyed out while UK, EU or AU hold sizes, and US, UK, EU, AU past 20 columns", () => {
    const all = setRegions(usOnly(), "all");
    expect(canUsOnly(setWord(all, "t1.s.c2", "38"))).toBe(false);
    let full = usOnly();
    while (full.content.tables[0].columns.length < 18)
      full = addMeasurement(full);
    expect(canAll(full)).toBe(false);
    // At exactly 20 it still fits.
    expect(canAll(remove(full, { col: "bust" }))).toBe(true);
    expect(canAll(addSize(usOnly()))).toBe(true);
  });
});

describe("How to measure steps", () => {
  it("adds steps with ids unused anywhere in the chart, up to 20", () => {
    let d = toDraft(chart(), "DRAFT");
    d = addStep(addStep(d));
    expect(d.content.measure.steps).toEqual(["c1", "m1", "m2"]);
    d = setWord(setWord(d, "m.m1.name", "Bust"), "m.m1.text", "Around.");
    const saved = input(d);
    expect(validateChart(saved)).toEqual(saved);
    for (let i = 0; i < 30; i++) d = addStep(d);
    expect(d.content.measure.steps).toHaveLength(MAX_STEPS);
    expect(validateChart(input(d)).content.measure.steps).toHaveLength(20);
  });

  it("removes a step with its words, and keeps the others' numbers in order", () => {
    let d = addStep(addStep(toDraft(chart(), "DRAFT")));
    d = setWord(setWord(d, "m.m1.name", "Bust"), "m.m2.name", "Waist");
    d = removeStep(d, "m1");
    expect(d.content.measure.steps).toEqual(["c1", "m2"]);
    expect(d.content.words["m.m1.name"]).toBeUndefined();
    expect(d.content.words["m.m2.name"]).toBe("Waist");
  });

  it("points a step's or the tips' finding at its field", () => {
    const d = addStep(toDraft(chart(), "DRAFT"));
    expect(
      problems(d, {
        "content.words.m.m1.text": "Must be text of at most 500 characters",
        "content.words.tips": "Must be text of at most 2000 characters",
      }),
    ).toEqual([
      {
        id: "m-m1-text",
        where: "Step 2",
        long: "Must be text of at most 500 characters",
        table: 0,
      },
      {
        id: "tips",
        where: "Fit tips",
        long: "Must be text of at most 2000 characters",
        table: 0,
      },
    ]);
  });
});

describe("tables", () => {
  it("edits a later table with the table tools once it's focused, and puts it back", () => {
    const d = toDraft(chart(), "DRAFT");
    const view = focus(d, 1);
    expect(view.content.tables.map((t) => t.id)).toEqual(["t2", "t1"]);
    const back = focus(addMeasurement(addSize(view)), 1);
    expect(back.content.tables.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(back.content.tables[1].rows).toHaveLength(2);
    expect(back.content.tables[1].columns).toHaveLength(3);
    expect(focus(d, 0)).toBe(d);
    const errs = {
      "content.tables.0.rows": "a",
      "content.tables.1.rows.0.cells.len": "b",
      "content.tables.2.rows": "c",
      name: "d",
    };
    expect(focusErrors(errs, 1)).toEqual({
      "content.tables.1.rows": "a",
      "content.tables.0.rows.0.cells.len": "b",
      "content.tables.2.rows": "c",
      name: "d",
    });
    expect(focusErrors(focusErrors(errs, 1), 1)).toEqual(errs);
  });

  it("adds a table with the first table's sizes, which saves as it is", () => {
    const d = addTable(toDraft(chart(), "DRAFT"));
    const t = d.content.tables[2];
    expect(t.columns).toEqual([{ id: "c2", kind: "size" }]);
    expect(t.rows.map((r) => d.content.words[`${t.id}.${r.id}.c2`])).toEqual([
      "XS",
      "S",
    ]);
    expect(d.content.words[`${t.id}.c2`]).toBe("Size");
    expect(() => validateChart(input(d))).not.toThrow();
    expect(addTable(addTable(d)).content.tables).toHaveLength(MAX_TABLES);
  });

  it("clones a table with its own ids, words and typed values", () => {
    let d = toDraft(chart(), "DRAFT");
    d = setWord(d, "t2.title", "Garment measurements");
    d = setCell(d, "r1", "len", "25.5");
    d = cloneTable(d, 1);
    const [, t2, t3] = d.content.tables;
    expect(t3.id).not.toBe(t2.id);
    const [size, len] = t3.columns.map((c) => c.id);
    const row = t3.rows[0].id;
    expect(d.content.words[`${t3.id}.title`]).toBe("Garment measurements");
    expect(d.content.words[`${t3.id}.${len}`]).toBe("Length");
    expect(d.content.words[`${t3.id}.${row}.${size}`]).toBe("XS");
    expect(d.cells[`${row}.${len}`]).toBe("25.5");
    const saved = input(d);
    expect(validateChart(saved).content.tables[2].rows[0].cells).toEqual({
      [len]: [25.5],
    });
    // Ids stay unique across the chart.
    const ids = saved.content.tables.flatMap((t) => [
      t.id,
      ...t.columns.map((c) => c.id),
      ...t.rows.map((r) => r.id),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(cloneTable(cloneTable(d, 0), 0).content.tables).toHaveLength(4);
  });

  it("removes a later table with its words and values, never the first or the fit finder's", () => {
    let d = setCell(toDraft(chart(), "DRAFT"), "r1", "len", "26");
    const errs = {
      "content.tables.1.rows.0.cells.len": "a",
      "content.words.t2.len": "b",
      "content.tables.2.rows": "c",
      "content.tables.0.rows": "d",
    };
    expect(canRemoveTable(d, 0)).toBe(false);
    expect(removeTableErrors(d, 1, errs)).toEqual({
      "content.tables.1.rows": "c",
      "content.tables.0.rows": "d",
    });
    const gone = removeTable(d, 1);
    expect(gone.content.tables.map((t) => t.id)).toEqual(["t1"]);
    expect(
      Object.keys(gone.content.words).filter((k) => k.startsWith("t2.")),
    ).toEqual([]);
    expect(gone.cells["r1.len"]).toBeUndefined();
    d = { ...d, content: { ...d.content, fit: { table: "t2" } as never } };
    expect(canRemoveTable(d, 1)).toBe(false);
    expect(removeTable(d, 1)).toBe(d);
  });

  it("names a table by its heading and lists its measurements", () => {
    const d = setWord(toDraft(chart(), "DRAFT"), "t2.title", " Garment ");
    expect(tableTitle(d, 1)).toBe("Garment");
    expect(tableTitle(d, 0)).toBe("");
    const two = addMeasurement(focus(d, 1));
    const col = two.content.tables[0].columns[2].id;
    const back = focus(setWord(two, `t2.${col}`, "Sleeve"), 1);
    expect(measuresOf(back, 1)).toBe("Length and sleeve");
    expect(measuresOf(addTable(d), 2)).toBe("");
  });
});

describe("fit video", () => {
  it("saves an https YouTube or Vimeo link, trimmed, and leaves out an emptied one", () => {
    const d = setVideo(toDraft(chart(), "DRAFT"), " https://vimeo.com/1 ");
    expect(input(d).content.videoUrl).toBe("https://vimeo.com/1");
    const none = setVideo(d, "");
    expect("videoUrl" in none.content).toBe(false);
    expect("videoUrl" in input(none).content).toBe(false);
  });

  it.each([
    "http://youtube.com/watch?v=x",
    "https://www.tiktok.com/@a/video/1",
    "youtube.com/watch?v=x",
  ])("refuses %s in the editor's words", (link) => {
    const r = toInput(setVideo(toDraft(chart(), "DRAFT"), link));
    expect("fieldErrors" in r && r.fieldErrors).toEqual({
      "content.videoUrl": "Use an https link from YouTube or Vimeo.",
    });
  });
});
