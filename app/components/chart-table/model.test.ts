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
