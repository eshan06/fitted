import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { validateChart } from "./chart.server";
import {
  CSV_MAX_BYTES,
  CsvFileError,
  exportCsv,
  importCsv,
} from "./csv-import.server";

const stream = (data: string | Uint8Array) =>
  new Blob([typeof data === "string" ? data : Uint8Array.from(data)]).stream();
const drafts = (csv: string, fileName?: string) =>
  importCsv(stream(csv), fileName);
const reasonOf = async (csv: string) => {
  const [draft] = await drafts(csv);
  expect(draft.status).toBe("unreadable");
  return "reason" in draft ? draft.reason : "";
};
const fileError = (data: string | Uint8Array | null) =>
  importCsv(data === null ? null : stream(data)).then(
    () => expect.unreachable(),
    (err) => {
      expect(err).toBeInstanceOf(CsvFileError);
      return err.message;
    },
  );

// Every part of a chart, with text a spreadsheet would mangle: commas,
// quotes, line breaks, formula starts, apostrophes and non-Latin script.
const tops = () => ({
  name: `Women's tops, "relaxed"`,
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
          { id: "us", kind: "country", country: "US" },
          { id: "chest", kind: "measure", convert: true },
          { id: "wt", kind: "measure", unit: "lb", convert: false },
          { id: "foot", kind: "measure", unit: "cm", convert: true },
          { id: "fitnote", kind: "text" },
        ],
        rows: [
          {
            id: "s",
            cells: { chest: [34, 35.5], wt: [120], foot: [22.25, 22.25] },
          },
          { id: "m", cells: { chest: [36, 37.5], wt: [0.0000001] } },
          { id: "l", cells: {} },
        ],
        merges: [{ row: "s", col: "fitnote", rows: 3, cols: 1 }],
        wrap: ["fitnote"],
      },
      {
        id: "t2",
        columns: [
          { id: "sz", kind: "size" },
          { id: "uk", kind: "country", country: "UK" },
        ],
        rows: [{ id: "a", cells: {} }],
      },
    ],
    measure: { steps: ["bust"] },
    videoUrl: "https://www.youtube.com/watch?v=abc",
    fit: {
      table: "t1",
      questions: [
        { id: "q1", kind: "measure", col: "chest", optional: false },
        { id: "q2", kind: "usual_size" },
        { id: "q4", kind: "choice", options: [{ id: "a", rows: ["s", "m"] }] },
      ],
      ease: { chest: 2, wt: -1 },
      stretch: "some",
    },
    words: {
      "t1.title": "Tops",
      "t1.sub": "Body measurements, in inches",
      "t1.note": "Between sizes?\r\nSize up.",
      "t1.size": "Size",
      "t1.chest": "Chest",
      "t1.wt": "=Weight",
      "t1.s.size": "S",
      "t1.m.size": "@M",
      "t1.l.size": "+L",
      "t1.s.us": "4",
      "t1.m.us": "-6",
      "t1.s.fitnote": `Runs "small"; true to size`,
      "t1.m.fitnote": "\tindented",
      "t1.l.fitnote": "'quoted",
      "t2.title": "'=Kids",
      "t2.a.sz": "2T – 3T",
      "t2.a.uk": "ñ 中 😀",
      "m.bust.name": "Bust",
      "m.bust.text": "Around the fullest part",
      tips: "Measure over light clothing.\n\nAsk us anytime.",
      "fit.q1": "Your chest?",
      "fit.q4": "Body shape?",
      "fit.q4.a": "Straight",
    },
  },
});
const rings = () => ({
  name: "Rings",
  template: "rings",
  content: {
    v: 1,
    unit: "cm",
    roundTo: 0.25,
    tables: [
      {
        id: "r",
        columns: [
          { id: "s", kind: "size" },
          { id: "dia", kind: "measure", convert: false },
        ],
        rows: [{ id: "x", cells: { dia: [1.5] } }],
      },
    ],
    measure: { steps: [] },
    words: { "r.s": "Ring size", "r.x.s": "5" },
  },
});
const stored = (chart: ReturnType<typeof tops | typeof rings>) => {
  const valid = validateChart(chart);
  return { name: valid.name, chart: valid };
};
const ready = (chart: ReturnType<typeof tops | typeof rings>) => {
  const { name, template, content } = validateChart(chart);
  return { name, template, content, products: [], status: "ready" };
};

describe("export then import", () => {
  it("brings every chart back unchanged", async () => {
    const csv = exportCsv([stored(tops()), stored(rings())]);
    expect(await drafts(csv)).toEqual([ready(tops()), ready(rings())]);
  });

  it("writes a UTF-8 file Excel opens, with Fitted's header row", () => {
    const csv = exportCsv([stored(rings())]);
    expect(csv.startsWith("﻿Fitted size charts,1\r\n")).toBe(true);
    expect(csv.split("\r\n")).toContain("Row,x,5,1.5");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("neutralizes cells a spreadsheet would run as formulas", () => {
    const cells = exportCsv([stored(tops())]).split(/,|\r\n/);
    for (const cell of ["'=Weight", "'@M", "'+L", "'-6", "''=Kids"])
      expect(cells).toContain(cell);
    expect(cells).toContain("'\tindented");
    // Text that only looks close is left alone.
    expect(cells).toContain("'quoted");
    expect(cells).toContain("4");
  });

  it("names a chart that fails validation instead of dropping it", async () => {
    const csv = exportCsv([
      { name: "Broken", chart: undefined },
      stored(rings()),
    ]);
    const [broken, ok] = await drafts(csv);
    expect(broken).toEqual({
      name: "Broken",
      products: [],
      status: "unreadable",
      reason:
        "Row 3: This chart had errors in Fitted when the file was made, so the file has only its name.",
    });
    expect(ok).toEqual(ready(rings()));
  });

  it("drops empty texts and surrounding spaces, which read the same", async () => {
    const chart = rings();
    Object.assign(chart.content.words, { "r.x.s": "  5  ", "r.title": "" });
    const [draft] = await drafts(exportCsv([stored(chart)]));
    expect(draft).toEqual(ready(rings()));
  });

  it("exports an empty store as just the header row, which imports as no charts", async () => {
    const csv = exportCsv([]);
    expect(csv).toBe("﻿Fitted size charts,1\r\n");
    expect(await fileError(csv)).toBe("The file has no charts.");
  });
});

describe("importing an edited export", () => {
  const base = [
    "Fitted size charts,1",
    "Chart,Edited,tops,in,1",
    "Table,t1,Tops",
    "Columns,,size:size,r1:measure",
    "Labels,,Size,Chest",
  ];

  it("makes ids for new rows and infers columns added without a type", async () => {
    const csv = [
      ...base,
      "Row,c1,S,34,Runs small",
      "Row,,M,36,",
      "Row,,L,,Long",
    ].join("\n");
    const [draft] = await drafts(csv);
    expect(draft.status).toBe("ready");
    if (draft.status !== "ready") return;
    const [t] = draft.content.tables;
    // Generated ids skip the ones the file already uses.
    expect(t.rows.map((r) => r.id)).toEqual(["c1", "r2", "r3"]);
    expect(t.columns).toEqual([
      { id: "size", kind: "size" },
      { id: "r1", kind: "measure", convert: true },
      { id: "c2", kind: "text" },
    ]);
    expect(t.rows[1].cells).toEqual({ r1: [36] });
    expect(draft.content.words).toMatchObject({
      "t1.c1.c2": "Runs small",
      "t1.r3.c2": "Long",
    });
  });

  it("keeps a chart without a Settings row, with no measuring steps", async () => {
    const [draft] = await drafts([...base, "Row,s,S,34"].join("\n"));
    expect(draft.status === "ready" && draft.content.measure).toEqual({
      steps: [],
    });
  });

  it("reads a copy a spreadsheet saved with semicolons and decimal commas", async () => {
    const csv = [
      "Fitted size charts;1",
      "Chart;Edited;tops;cm;0,5",
      "Table;t1",
      "Columns;;size:size;chest:measure",
      "Row;s;S;86,5–90",
      "Merge;s;size;1;1",
    ].join("\r\n");
    const [draft] = await drafts(csv);
    expect(draft.status).toBe("ready");
    if (draft.status !== "ready") return;
    expect(draft.content.roundTo).toBe(0.5);
    expect(draft.content.tables[0].rows[0].cells).toEqual({
      chest: [86.5, 90],
    });
  });
});

describe("importing a spreadsheet", () => {
  it("reads Fitted's template as a ready chart in inches", async () => {
    const file = readFileSync("public/fitted-template.csv");
    const [draft] = await importCsv(stream(file), "fitted-template.csv");
    expect(draft).toMatchObject({
      name: "fitted-template",
      template: "blank",
      status: "ready",
      products: [],
    });
    if (draft.status !== "ready") return;
    expect(draft.content.unit).toBe("in");
    const [t] = draft.content.tables;
    expect(t.columns.map((c) => c.kind)).toEqual([
      "size",
      "measure",
      "measure",
      "measure",
    ]);
    expect(t.columns.every((c) => !("unit" in c))).toBe(true);
    expect(t.rows).toHaveLength(5);
    expect(t.rows[3].cells).toEqual({
      c2: [37.5, 39],
      c3: [30.5, 32],
      c4: [40.5, 42],
    });
    expect(draft.content.words).toMatchObject({
      "t1.c1": "Size",
      "t1.c2": "Bust",
      "t1.c4": "Hips",
      "t1.r1.c1": "XS",
    });
  });

  it("finds country, measure and text columns, and units from the labels", async () => {
    const csv = [
      "Size;US;EU size;Chest (cm);Waist cm;Weight [kg];Fit",
      "S;4;36;86,5–90;70 to 74;–;Runs small",
      "M;6;38;91 - 95;75—79;60;",
    ].join("\n");
    const [draft] = await drafts(csv, "Dresses.csv");
    expect(draft).toMatchObject({ name: "Dresses", status: "ready" });
    if (draft.status !== "ready") return;
    expect(draft.content.unit).toBe("cm");
    const [t] = draft.content.tables;
    expect(t.columns).toEqual([
      { id: "c1", kind: "size" },
      { id: "c2", kind: "country", country: "US" },
      { id: "c3", kind: "country", country: "EU" },
      { id: "c4", kind: "measure", convert: true },
      { id: "c5", kind: "measure", convert: true },
      { id: "c6", kind: "measure", unit: "kg", convert: true },
      { id: "c7", kind: "text" },
    ]);
    expect(t.rows.map((r) => r.cells)).toEqual([
      { c4: [86.5, 90], c5: [70, 74] },
      { c4: [91, 95], c5: [75, 79], c6: [60] },
    ]);
    expect(draft.content.words).toMatchObject({
      "t1.c4": "Chest",
      "t1.c5": "Waist",
      "t1.c6": "Weight",
      "t1.r1.c2": "4",
      "t1.r1.c7": "Runs small",
    });
  });

  it("keeps a length column in another unit as its own", async () => {
    const [draft] = await drafts(
      "Size,Foot (in),Foot (cm),Length (in)\n8,9.5,24,10",
    );
    expect(draft.status === "ready" && draft.content).toMatchObject({
      unit: "in",
      tables: [
        {
          columns: [
            { kind: "size" },
            { kind: "measure", convert: true },
            { kind: "measure", unit: "cm", convert: true },
            { kind: "measure", convert: true },
          ],
        },
      ],
    });
  });

  it("asks to check units when no label names one", async () => {
    const [draft] = await drafts("Size,Chest\nS,34\nM,36", "tops.csv");
    expect(draft).toMatchObject({
      status: "check_units",
      reason:
        "The file doesn't say whether the measurements are in inches or centimeters.",
    });
    if (draft.status !== "check_units") return;
    expect(draft.content.unit).toBe("in");
    expect(draft.content.tables[0].columns[1]).toEqual({
      id: "c2",
      kind: "measure",
      convert: true,
    });
  });

  it("reads quotes, line breaks, a BOM, blank rows and trailing empty columns", async () => {
    const csv =
      '﻿Size,"Chest, relaxed (in)",Note,,\r\n,,,,\r\n' +
      'S, "34–35" ,"Fits ""small""\nand short",,\r\n' +
      '"M ""tall""",36,,,\r\n';
    const [draft] = await drafts(csv);
    expect(draft.status).toBe("ready");
    if (draft.status !== "ready") return;
    const [t] = draft.content.tables;
    expect(t.columns).toHaveLength(3);
    expect(t.rows.map((r) => r.cells)).toEqual([
      { c2: [34, 35] },
      { c2: [36] },
    ]);
    expect(draft.content.words).toEqual({
      "t1.c1": "Size",
      "t1.c2": "Chest, relaxed",
      "t1.c3": "Note",
      "t1.r1.c1": "S",
      "t1.r1.c3": 'Fits "small"\nand short',
      "t1.r2.c1": 'M "tall"',
    });
  });

  it("picks the delimiter from the first row, ignoring quoted commas", async () => {
    const [draft] = await drafts('Size;"Chest, relaxed (in)"\nS;34');
    expect(draft.status === "ready" && draft.content.words).toEqual({
      "t1.c1": "Size",
      "t1.c2": "Chest, relaxed",
      "t1.r1.c1": "S",
    });
  });

  it("reads tab-separated files", async () => {
    const [draft] = await drafts("Size\tChest (in)\nS\t34");
    expect(draft.status === "ready" && draft.content.tables[0].rows).toEqual([
      { id: "r1", cells: { c2: [34] } },
    ]);
  });

  it("reads a file streamed in pieces that split a character", async () => {
    const bytes = new TextEncoder().encode("Size,Chest (in)\nS,34–35");
    const at = bytes.indexOf(0xe2) + 1; // inside the en dash
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, at));
        c.enqueue(bytes.slice(at));
        c.close();
      },
    });
    const [draft] = await importCsv(body);
    expect(draft.status === "ready" && draft.content.tables[0].rows).toEqual([
      { id: "r1", cells: { c2: [34, 35] } },
    ]);
  });

  it("names the chart after the file, or a default", async () => {
    const [named] = await drafts("Size\nS", "  Men's   shirts .csv");
    expect(named.name).toBe("Men's shirts");
    const [unnamed] = await drafts("Size\nS", ".csv");
    expect(unnamed.name).toBe("Imported chart");
  });
});

describe("row-level errors", () => {
  it("names the row and column of each bad cell, counting blank rows", async () => {
    const reason = await reasonOf(
      "Size,Chest (in),Hips (in)\n\nS,abc,40\nM,40–30,0\nL,N/A,10000",
    );
    expect(reason).toBe(
      "Row 3, Chest: Use a number like 34.5 or a range like 34–36; " +
        "Row 4, Chest: Use a number above 0 and below 10,000, or a range from low to high; " +
        "Row 4, Hips: Use a number above 0 and below 10,000, or a range from low to high; " +
        "Row 5, Chest: Use a number like 34.5 or a range like 34–36; " +
        "Row 5, Hips: Use a number above 0 and below 10,000, or a range from low to high.",
    );
  });

  it("reads a column of mostly numbers as measurements, flagging the rest", async () => {
    expect(await reasonOf("Size,Inseam\nS,30\nM,32\nL,N/A")).toBe(
      "Row 4, Inseam: Use a number like 34.5 or a range like 34–36.",
    );
    // Mostly words: a text column, numbers and all.
    const [draft] = await drafts("Size,Fit\nS,Runs small\nM,Long\nL,2");
    expect(draft.status === "ready" && draft.content.tables[0].columns).toEqual(
      [
        { id: "c1", kind: "size" },
        { id: "c2", kind: "text" },
      ],
    );
  });

  it("refuses the same text given twice", async () => {
    const csv = [
      "Fitted size charts,1",
      "Chart,Shirts,tops,in,1",
      "Table,t1,Tops",
      "Row,s,S",
      "Text,t1.title,Shirts",
    ].join("\n");
    expect(await reasonOf(csv)).toBe("Row 5: This text is given twice.");
  });

  it("lists the first five problems and counts the rest", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => `S${i},x`);
    const reason = await reasonOf(["Size,Chest (in)", ...rows].join("\n"));
    expect(reason).toMatch(
      /^Row 2, Chest: .*Row 6, Chest: [^;]*; and 2 more\.$/,
    );
  });

  it("refuses more than 60 size rows or 20 columns", async () => {
    const rows = Array.from({ length: 61 }, (_, i) => `S${i},34`);
    expect(await reasonOf(["Size,Chest (in)", ...rows].join("\n"))).toBe(
      "Row 62: A table needs 1 to 60 size rows.",
    );
    const wide = Array.from({ length: 21 }, (_, i) => `C${i}`).join(",");
    expect(await reasonOf(`${wide}\n${wide}`)).toBe(
      "Row 1: A table needs 1 to 20 columns.",
    );
    expect(await reasonOf("Size,Chest")).toBe(
      "Row 1: A table needs 1 to 60 size rows.",
    );
  });

  it("marks only the bad chart in a file of several", async () => {
    const second = ["Chart,Second,pants,in,2", "Table,t1", "Row,s,S"];
    const csv = exportCsv([stored(rings())]) + second.join("\r\n");
    const [first, bad] = await drafts(csv);
    expect(first).toEqual(ready(rings()));
    expect(bad).toEqual({
      name: "Second",
      products: [],
      status: "unreadable",
      reason: "Row 8: Pick a template; Row 8: Pick 0.25, 0.5 or 1.",
    });
  });

  it("points each problem in Fitted's layout at its row", async () => {
    const csv = [
      "Fitted size charts,1",
      "Chart,Shirts,tops,in,1",
      'Settings,"{""measure"":{""steps"":[]},""tables"":[]}"',
      "Columns,,size:size",
      "Table,t1",
      "Columns,,size:size,us:US,x:weird",
      "Row,s,S,4,",
      "Row,s",
      "Text,nope,Hello",
      "Text,__proto__,Hi",
      "Mystery,1",
    ].join("\n");
    expect(await reasonOf(csv)).toBe(
      "Row 3: This Settings row isn't in the form Fitted writes; " +
        "Row 4: Put a Table row above this row; " +
        "Row 6, column E: Fitted doesn't know the column type “x:weird”; " +
        'Row 8: "s" is already used; ' +
        "Row 9: Not a word this chart uses; and 2 more.",
    );
  });

  it("treats a row named like a built-in property as unknown", async () => {
    const csv = [
      "Fitted size charts,1",
      "Chart,Shirts,tops,in,1",
      "Table,t1",
      "Row,s,S",
      "toString,x",
      "constructor,y",
    ].join("\n");
    expect(await reasonOf(csv)).toBe(
      "Row 5: Fitted doesn't expect a “toString” row here; " +
        "Row 6: Fitted doesn't expect a “constructor” row here.",
    );
  });

  it("never lets a Settings row replace the chart's tables", async () => {
    const csv = [
      "Fitted size charts,1",
      "Chart,Shirts,tops,in,1",
      'Settings,"{""tables"":[],""words"":{}}"',
      "Table,t1",
      "Row,s,S",
    ].join("\n");
    expect(await reasonOf(csv)).toBe(
      "Row 3: This Settings row isn't in the form Fitted writes.",
    );
  });

  it("refuses a chart without tables, or with more than four", async () => {
    const head = ["Fitted size charts,1", "Chart,Shirts,tops,in,1"];
    expect(await reasonOf(head.join("\n"))).toBe(
      "Row 2: A chart needs 1 to 4 tables.",
    );
    const five = Array.from(
      { length: 5 },
      (_, i) => `Table,t${i}\nRow,r${i},S`,
    );
    expect(await reasonOf([...head, ...five].join("\n"))).toBe(
      "Row 11: A chart needs 1 to 4 tables.",
    );
  });
});

describe("file-level errors", () => {
  it("cuts an upload off at 1 MB without reading the rest", async () => {
    let pulled = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(64 * 1024).fill(0x61));
      },
      cancel,
    });
    await expect(importCsv(body)).rejects.toThrow(
      "The file is over 1 MB. Split it into smaller files and upload each one.",
    );
    expect(pulled).toBeLessThanOrEqual(CSV_MAX_BYTES / (64 * 1024) + 2);
    expect(cancel).toHaveBeenCalled();
  });

  // One app instance serves every shop (§17), so a hostile file must not stall it.
  it.each([
    ["a long run of digits", `Size,Chest\nS,${"1".repeat(400_000)}x`],
    ["a label padded with spaces", `Size,a${" ".repeat(400_000)}b\nS,1`],
    ["a cell full of quotes", `Size,Chest\nS,x${'"'.repeat(400_000)}`],
  ])("reads %s in linear time", async (_, csv) => {
    const start = Date.now();
    await drafts(csv);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("accepts a file of exactly 1 MB", async () => {
    const csv = `Size\n${"x".repeat(CSV_MAX_BYTES - 5)}`;
    await expect(drafts(csv)).resolves.toHaveLength(1);
  });

  it("refuses binary files, workbooks, PDFs and text that isn't UTF-8", async () => {
    const SAVE_AS =
      "This isn't a UTF-8 CSV file. Save it from your spreadsheet app as CSV UTF-8, then upload that.";
    expect(await fileError(new Uint8Array([0x53, 0x00, 0x2c]))).toBe(SAVE_AS);
    expect(await fileError("PK\u0003\u0004rest")).toBe(SAVE_AS);
    expect(await fileError("%PDF-1.7\n1 0 obj")).toBe(SAVE_AS);
    // "S,34–36" saved as Windows-1252: the en dash is byte 0x96.
    const ansi = new Uint8Array([0x53, 0x2c, 0x33, 0x34, 0x96, 0x33, 0x36]);
    expect(await fileError(ansi)).toBe(SAVE_AS);
  });

  it("refuses an empty file", async () => {
    expect(await fileError("")).toBe("The file is empty.");
    expect(await fileError("﻿\r\n,,\r\n")).toBe("The file is empty.");
    expect(await fileError(null)).toBe("The file is empty.");
  });

  it("refuses a quote that never closes, naming its row", async () => {
    expect(await fileError('Size,Chest\nS,"34\nM,36')).toBe(
      'Row 2: a quote (") is never closed.',
    );
  });

  it("refuses Fitted files it can't place", async () => {
    expect(await fileError("Fitted size charts,2\nChart,A")).toBe(
      "Row 1: Fitted can't read this version of its CSV.",
    );
    expect(await fileError("Fitted size charts,1\n\nTable,t1")).toBe(
      "Row 3: put a Chart row above it.",
    );
  });
});
