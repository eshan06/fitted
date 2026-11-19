import { describe, expect, it, vi } from "vitest";
import { validateChart } from "./chart.server";
import {
  CSV_MAX_BYTES,
  CsvFileError,
  exportCsv,
  importCsv,
} from "./csv-import.server";

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
      "t1.l.us": "\rx",
      "t1.s.fitnote": `Runs "small"; true to size`,
      "t1.m.fitnote": "\tindented",
      "t1.l.fitnote": "'quoted",
      "t2.title": "'=Kids",
      "t2.sub": "a\rb",
      "t2.note": "",
      "t2.a.sz": " 2T – 3T ",
      "t2.a.uk": "ñ 中 😀",
      "m.bust.name": "Bust",
      "m.bust.text": "Around the fullest part",
      tips: "Measure over light clothing.\n- Ask us;@noon\t+1",
      "fit.q1": `Your chest?;"=1"`,
      "fit.q4": "Body shape?",
      "fit.q4.a": "Straight",
    },
  },
});
const stored = (chart: unknown) => {
  const valid = validateChart(chart);
  return { name: valid.name, chart: valid };
};

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
// The whole file Excel sees: a BOM, the layout's row, then CRLF rows.
const file = (...rows: string[]) =>
  ["\uFEFFFitted size charts,1", ...rows, ""].join("\r\n");
const ringsRows = [
  "Chart,Rings,rings,cm,0.25",
  `Settings,"{""measure"":{""steps"":[]}}"`,
  "Table,r,,,",
  "Columns,,s:size,dia:measure:fixed",
  "Labels,,Ring size,",
  "Row,x,5,1.5",
];

describe("exportCsv", () => {
  it("writes every part of a chart, one row per size row", () => {
    expect(exportCsv([stored(tops())])).toBe(
      file(
        `Chart,"Women's tops, ""relaxed""",tops,in,0.5`,
        `Settings,"{""measure"":{""steps"":[""bust""]},""videoUrl"":""https://www.youtube.com/watch?v=abc"",""fit"":{""table"":""t1"",""questions"":[{""id"":""q1"",""kind"":""measure"",""col"":""chest"",""optional"":false},{""id"":""q4"",""kind"":""choice"",""options"":[{""id"":""a"",""rows"":[""s"",""m""]}]}],""ease"":{""chest"":2,""wt"":-1},""stretch"":""some""}}"`,
        `Table,t1,Tops,"Body measurements, in inches","Between sizes?\r\nSize up."`,
        "Columns,,size:size,us:US,chest:measure,wt:lb:fixed,foot:cm,fitnote:text",
        // Formula starts get an apostrophe; text that only looks close doesn't.
        "Labels,,Size,,Chest,'=Weight,,",
        `Row,s,S,4,34–35.5,120,22.25–22.25,"Runs ""small""; true to size"`,
        "Row,m,'@M,'-6,36–37.5,1e-7,,'\tindented",
        `Row,l,'+L,"'\rx",,,,'quoted`,
        "Merge,s,fitnote,3,1",
        "Wrap,fitnote",
        // An apostrophe that already leads a formula start gets one more. An
        // empty text is "", unlike no text, and spaces around text are quoted.
        `Table,t2,''=Kids,"a\rb",""`,
        "Columns,,sz:size,uk:UK",
        "Labels,,,",
        `Row,a," 2T – 3T ",ñ 中 😀`,
        "Text,m.bust.name,Bust",
        "Text,m.bust.text,Around the fullest part",
        // A spreadsheet may start a cell after a line break, ; or tab, too.
        `Text,tips,"Measure over light clothing.\n'- Ask us;'@noon\t'+1"`,
        `Text,fit.q1,"Your chest?;'""=1"""`,
        "Text,fit.q4,Body shape?",
        "Text,fit.q4.a,Straight",
      ),
    );
  });

  it("writes a chart without extras in just the rows it needs", () => {
    expect(exportCsv([stored(rings())])).toBe(file(...ringsRows));
  });

  it("names a chart that fails validation instead of dropping it", () => {
    expect(exportCsv([{ name: "Broken" }, stored(rings())])).toBe(
      file(
        "Chart,Broken",
        "Error,This chart has errors in Fitted",
        ...ringsRows,
      ),
    );
  });

  it("writes an empty store as just the layout's row", () => {
    expect(exportCsv([])).toBe(file());
  });
});

const BOM = String.fromCharCode(0xfeff);
const stream = (data: string | Uint8Array) =>
  new Blob([typeof data === "string" ? data : Uint8Array.from(data)]).stream();
const drafts = (csv: string) => importCsv(stream(csv));
const ready = (chart: unknown) => {
  const { name, template, content } = validateChart(chart);
  return { name, template, content, products: [], status: "ready" };
};
const reasonOf = async (csv: string) => {
  const [draft] = await drafts(csv);
  expect(draft.status).toBe("unreadable");
  return draft.status === "unreadable" ? draft.reason : "";
};
const fileError = (data: string | Uint8Array | null) =>
  importCsv(data === null ? null : stream(data)).then(
    () => expect.unreachable(),
    (err) => {
      expect(err).toBeInstanceOf(CsvFileError);
      return err.message;
    },
  );
// Fitted's layout as a merchant might edit it: no BOM, LF line ends.
const fitted = (...rows: string[]) =>
  ["Fitted size charts,1", ...rows].join("\n");
const SPLIT =
  "To split a Fitted export, copy its first row to the top of each file and split only above a Chart row.";

describe("export then import", () => {
  it("brings every chart back unchanged", async () => {
    const csv = exportCsv([stored(tops()), stored(rings())]);
    expect(await drafts(csv)).toEqual([ready(tops()), ready(rings())]);
  });

  it("brings back every kind of column", async () => {
    const chart = {
      name: "Every column",
      template: "blank",
      content: {
        v: 1,
        unit: "cm",
        roundTo: 1,
        tables: [
          {
            id: "a",
            columns: [
              { id: "s", kind: "size" },
              { id: "eu", kind: "country", country: "EU" },
              { id: "au", kind: "country", country: "AU" },
              { id: "kg", kind: "measure", unit: "kg", convert: true },
              { id: "inch", kind: "measure", unit: "in", convert: false },
              { id: "t", kind: "text" },
            ],
            rows: [{ id: "r", cells: { kg: [60], inch: [1, 2] } }],
          },
        ],
        measure: { steps: [] },
        words: {
          "a.r.s": "S",
          "a.r.eu": "36",
          "a.r.au": "8",
          "a.r.t": "Loose",
        },
      },
    };
    expect(await drafts(exportCsv([stored(chart)]))).toEqual([ready(chart)]);
  });

  // Every piece of text a spreadsheet trips on, in a seeded random order.
  it("brings any text back exactly", async () => {
    let seed = 7;
    const rand = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
    const parts = ["'", '"', "=", "+", "-", "@", "\t", "\r", "\n", ";", ","];
    parts.push(" ", "a", "ñ", "😀", "");
    const text = () =>
      Array.from({ length: rand(8) }, () => parts[rand(parts.length)]).join("");
    for (let i = 0; i < 300; i++) {
      const chart = rings();
      chart.name = `R${text().replace(/[\r\n]/g, "")}`;
      const words = { "r.s": text(), "r.x.s": text(), "r.title": text() };
      Object.assign(chart.content.words, words, { tips: text() });
      expect(await drafts(exportCsv([stored(chart)]))).toEqual([ready(chart)]);
    }
  });

  it("names a chart that failed validation instead of dropping it", async () => {
    const csv = exportCsv([{ name: "Broken" }, stored(rings())]);
    expect(await drafts(csv)).toEqual([
      {
        name: "Broken",
        products: [],
        status: "unreadable",
        reason:
          "Row 3: This chart had errors in Fitted when the file was made, so the file has only its name.",
      },
      ready(rings()),
    ]);
  });

  it("reads an empty store's export as a file with no charts", async () => {
    expect(await fileError(exportCsv([]))).toBe("The file has no charts.");
  });

  it("reads a file streamed in pieces that split a character", async () => {
    const bytes = new TextEncoder().encode(exportCsv([stored(tops())]));
    const at = bytes.indexOf(0xe2) + 1; // inside the first en dash
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, at));
        c.enqueue(bytes.slice(at));
        c.close();
      },
    });
    expect(await importCsv(body)).toEqual([ready(tops())]);
  });
});

describe("importing an edited export", () => {
  it("reads a file saved with old Mac line ends", async () => {
    const csv = exportCsv([stored(rings())]).replaceAll("\r\n", "\r");
    expect(await drafts(csv)).toEqual([ready(rings())]);
  });

  it("reads an export a spreadsheet saved again", async () => {
    // No BOM, LF line ends, and every row padded to the same width.
    const rows = exportCsv([stored(rings())])
      .slice(1)
      .split("\r\n");
    const csv = rows.map((r) => (r ? `${r}${",".repeat(6)}` : r)).join("\n");
    expect(await drafts(csv)).toEqual([ready(rings())]);
  });

  it("reads numbers and ranges as a spreadsheet may write them", async () => {
    const csv = fitted(
      "Chart,Rings,rings,cm,0.25",
      "Table,r",
      "Columns,,s:size,dia:measure:fixed",
      ...["1.5 - 2", "2 to 2.5", "2.5—3", "1.00E-07", ".5"].map(
        (v, i) => `Row,r${i},${i},${v}`,
      ),
    );
    const [draft] = await drafts(csv);
    const cells = draft.status === "ready" && draft.content.tables[0].rows;
    expect(cells && cells.map((r) => r.cells.dia)).toEqual([
      [1.5, 2],
      [2, 2.5],
      [2.5, 3],
      [1e-7],
      [0.5],
    ]);
  });

  it("tells no text from an empty text, and trims only unquoted cells", async () => {
    const csv = fitted(
      "Chart,Rings,rings,cm,1",
      'Table,r,,""," Note "',
      "Columns,,s:size",
      "Labels,,  Ring size  ",
      'Row,x, "5" ',
      'Text,tips,"Measure" twice ',
    );
    const [draft] = await drafts(csv);
    expect(draft.status === "ready" && draft.content.words).toEqual({
      "r.sub": "",
      "r.note": " Note ",
      "r.s": "Ring size",
      "r.x.s": "5",
      tips: "Measure twice",
    });
  });

  it("keeps a chart without a Settings row, with no measuring steps", async () => {
    const csv = fitted(
      "Chart,Rings,rings,cm,1",
      "Table,r",
      "Columns,,s:size",
      "Row,x,5",
    );
    const [draft] = await drafts(csv);
    expect(draft.status === "ready" && draft.content.measure).toEqual({
      steps: [],
    });
  });
});

describe("row-level errors", () => {
  const head = [
    "Chart,Shirts,tops,in,1",
    "Table,t1",
    "Columns,,size:size,chest:measure,hips:in",
    "Labels,,Size,Chest,Hips",
  ];

  it("names the row and column of each bad cell, counting blank rows", async () => {
    const rows = ["", "Row,s,S,abc,40", "Row,m,M,40–30,0", "Row,l,L,N/A,10000"];
    expect(await reasonOf(fitted(...head, ...rows))).toBe(
      "Row 7, Chest: Use a number like 34.5 or a range like 34–36; " +
        "Row 8, Chest: Use a number above 0 and below 10,000, or a range from low to high; " +
        "Row 8, Hips: Use a number above 0 and below 10,000, or a range from low to high; " +
        "Row 9, Chest: Use a number like 34.5 or a range like 34–36; " +
        "Row 9, Hips: Use a number above 0 and below 10,000, or a range from low to high.",
    );
  });

  it("lists the first five problems and counts the rest", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => `Row,r${i},S${i},x`);
    expect(await reasonOf(fitted(...head, ...rows))).toMatch(
      /^Row 6, Chest: .*Row 10, Chest: [^;]*; and 1 more\.$/,
    );
  });

  it("names a column by its letter when its label is blank or long", async () => {
    const csv = fitted(
      ...head.slice(0, 3),
      `Labels,,Size,,${"Hips ".repeat(9)}`,
      "Row,s,S,x,x",
    );
    expect(await reasonOf(csv)).toBe(
      "Row 6, column D: Use a number like 34.5 or a range like 34–36; " +
        "Row 6, column E: Use a number like 34.5 or a range like 34–36.",
    );
  });

  it("refuses the same text given twice", async () => {
    const csv = fitted(
      "Chart,Shirts,tops,in,1",
      "Table,t1,Tops",
      "Columns,,s:size",
      "Row,a,S",
      "Text,t1.title,Shirts",
    );
    expect(await reasonOf(csv)).toBe("Row 6: This text is given twice.");
  });

  it("refuses more than 60 size rows or 20 columns", async () => {
    const top = ["Chart,Shirts,tops,in,1", "Table,t1"];
    const rows = Array.from({ length: 61 }, (_, i) => `Row,r${i},S`);
    expect(await reasonOf(fitted(...top, "Columns,,s:size", ...rows))).toBe(
      "Row 65: A table needs 1 to 60 size rows.",
    );
    expect(await reasonOf(fitted(...top, "Columns,,s:size"))).toBe(
      "Row 3: A table needs 1 to 60 size rows.",
    );
    const wide = Array.from({ length: 20 }, (_, i) => `c${i}:text`);
    expect(
      await reasonOf(fitted(...top, `Columns,,s:size,${wide}`, "Row,a,S")),
    ).toBe("Row 4: A table needs 1 to 20 columns.");
    expect(await reasonOf(fitted(...top, "Row,a"))).toBe(
      "Row 3: A table needs 1 to 20 columns.",
    );
  });

  it("reports text past a row's last cell instead of dropping it", async () => {
    const csv = fitted(
      "Chart,Shirts,tops,in,1,extra",
      "Table,t1,Tops,,,extra",
      "Columns,,s:size",
      "Row,a,S",
      "Text,tips,Measure over light clothing, not a coat",
    );
    expect(await reasonOf(csv)).toBe(
      "Row 2: This row has more cells than Fitted reads; " +
        "Row 3: This row has more cells than Fitted reads; " +
        "Row 6: This row has more cells than Fitted reads.",
    );
  });

  it("reads Settings once, and each table's Columns row once", async () => {
    const settings = 'Settings,"{""measure"":{""steps"":[]}}"';
    const csv = fitted(
      "Chart,Shirts,tops,in,1",
      settings,
      settings,
      "Table,t1",
      "Columns,,s:size",
      "Columns,,s:size",
      "Row,a,S",
    );
    expect(await reasonOf(csv)).toBe(
      "Row 4: Fitted doesn't expect this row here; " +
        "Row 7: Fitted doesn't expect this row here.",
    );
  });

  it("names a chart without a name Untitled chart", async () => {
    const csv = fitted("Chart", "Table,t1", "Columns,,s:size", "Row,a,S");
    const [draft] = await drafts(csv);
    expect(draft).toMatchObject({
      name: "Untitled chart",
      status: "unreadable",
    });
  });

  it("marks only the bad chart in a file of several", async () => {
    const second = [
      "Chart,Second,pants,in,2",
      "Table,t1",
      "Columns,,s:size",
      "Row,a,S",
    ];
    const csv = exportCsv([stored(rings())]) + second.join("\r\n");
    expect(await drafts(csv)).toEqual([
      ready(rings()),
      {
        name: "Second",
        products: [],
        status: "unreadable",
        reason: "Row 8: Pick a template; Row 8: Pick 0.25, 0.5 or 1.",
      },
    ]);
  });

  it("points each problem in Fitted's layout at its row", async () => {
    const csv = fitted(
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
    );
    expect(await reasonOf(csv)).toBe(
      "Row 3: This Settings row isn't in the form Fitted writes; " +
        "Row 4: Put a Table row above this row; " +
        "Row 6, column E: Fitted doesn't know this column's type; " +
        'Row 8: "s" is already used; ' +
        "Row 9: Not a word this chart uses; and 2 more.",
    );
  });

  it("treats a row named like a built-in property as unknown", async () => {
    const csv = fitted(
      "Chart,Shirts,tops,in,1",
      "Table,t1",
      "Columns,,s:size",
      "Row,a,S",
      "toString,x",
      "constructor,y",
    );
    expect(await reasonOf(csv)).toBe(
      "Row 6: Fitted doesn't expect this row here; " +
        "Row 7: Fitted doesn't expect this row here.",
    );
  });

  it("never lets a Settings row replace the chart's tables or words", async () => {
    const csv = fitted(
      "Chart,Shirts,tops,in,1",
      'Settings,"{""tables"":[],""words"":{}}"',
      "Table,t1",
      "Columns,,s:size",
      "Row,a,S",
    );
    expect(await reasonOf(csv)).toBe(
      "Row 3: This Settings row isn't in the form Fitted writes.",
    );
  });

  it("refuses a chart without tables, or with more than four", async () => {
    const top = "Chart,Shirts,tops,in,1";
    expect(await reasonOf(fitted(top))).toBe(
      "Row 2: A chart needs 1 to 4 tables.",
    );
    const five = Array.from(
      { length: 5 },
      (_, i) => `Table,t${i},Title\nColumns,,s${i}:size\nRow,r${i},S`,
    );
    expect(await reasonOf(fitted(top, ...five))).toBe(
      "Row 15: A chart needs 1 to 4 tables.",
    );
  });

  it("reads no chart of 6,000 rows or more, which Fitted never writes", async () => {
    const texts = (n: number) =>
      Array.from({ length: n }, (_, i) => `Text,k${i},x`);
    expect(await reasonOf(fitted("Chart,Big", ...texts(6000)))).toBe(
      "Row 6002: The chart is too large; split it into smaller charts.",
    );
    expect(await reasonOf(fitted("Chart,Big", ...texts(5999)))).toMatch(
      /^Row 2: A chart needs 1 to 4 tables; /,
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
      `The file is over 1 MB. Split it into smaller files and upload each one. ${SPLIT}`,
    );
    expect(pulled).toBeLessThanOrEqual(CSV_MAX_BYTES / (64 * 1024) + 2);
    expect(cancel).toHaveBeenCalled();
  });

  it("reads a file of exactly 1 MB and refuses one byte more", async () => {
    const top = fitted("Chart,Rings", "Text,tips,");
    const csv = top + "x".repeat(CSV_MAX_BYTES - top.length);
    await expect(drafts(csv)).resolves.toHaveLength(1);
    expect(await fileError(`${csv}x`)).toMatch(/^The file is over 1 MB\./);
  });

  it("reads at most 1,000 charts from one file", async () => {
    const charts = (n: number) =>
      Array.from({ length: n }, (_, i) => `Chart,C${i}\nError,x`);
    await expect(drafts(fitted(...charts(1000)))).resolves.toHaveLength(1000);
    expect(await fileError(fitted(...charts(1001)))).toBe(
      `The file has more than 1,000 charts. Split it into files of at most 1,000 charts and upload each one. ${SPLIT}`,
    );
  });

  // One app instance serves every shop (§17), so a hostile file must not
  // stall it: each of these is a whole 1 MB of one trap.
  const fill = (before: string, unit: string, after = "") =>
    before +
    unit.repeat(
      Math.floor((CSV_MAX_BYTES - before.length - after.length) / unit.length),
    ) +
    after;
  const chart = ["Chart,A,tops,in,1", "Table,t1", "Columns,,s:size,c:in"];
  // Charts whose Settings hold unknown keys full of dots, so each error that
  // validateChart reports has a long path to place.
  const keys = Array.from(
    { length: 6 },
    (_, i) => `""${i}${".".repeat(16000)}"":0`,
  );
  const dotted = [
    "",
    ...chart.slice(0, 1),
    `Settings,"{""measure"":{${keys.join(",")}}}"`,
    ...chart.slice(1),
    "Row,a,S",
  ].join("\n");
  it.each([
    ["a long run of digits", fitted(...chart, "Row,a,S,"), "1", "x"],
    ["spaces before a quote", fitted(...chart, "Row,a,"), " ", '"S"'],
    ["a cell of doubled quotes", fitted(...chart, 'Text,tips,"'), '""', '"'],
    ["apostrophes after semicolons", fitted(...chart, "Text,tips,"), ";'", ""],
    ["one wide row", fitted(...chart, "Row,a,S"), ",", ""],
    ["thousands of tiny charts", fitted(), "\nChart", ""],
    ["one chart of junk rows", fitted(...chart), "\nx", ""],
    ["settings nested deep", fitted(...chart, 'Settings,"'), "[", '"'],
    ["settings keys full of dots", fitted(), dotted, ""],
    ["one wide Wrap row", fitted(...chart, "Row,a,S", "Wrap"), ",s", ""],
  ])("reads %s in linear time", async (_, before, unit, after) => {
    const csv = fill(before, unit, after);
    const start = Date.now();
    await drafts(csv).catch((err) => expect(err).toBeInstanceOf(CsvFileError));
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("refuses binary files, workbooks, PDFs and text that isn't UTF-8", async () => {
    const SAVE_AS =
      "This isn't a UTF-8 CSV file. Save it from your spreadsheet app as CSV UTF-8, then upload that.";
    expect(await fileError(new Uint8Array([0x53, 0x00, 0x2c]))).toBe(SAVE_AS);
    expect(await fileError("PK\x03\x04rest")).toBe(SAVE_AS);
    expect(await fileError("%PDF-1.7\n1 0 obj")).toBe(SAVE_AS);
    // "S,34–36" saved as Windows-1252: the en dash is byte 0x96.
    const ansi = new Uint8Array([0x53, 0x2c, 0x33, 0x34, 0x96, 0x33, 0x36]);
    expect(await fileError(ansi)).toBe(SAVE_AS);
    // UTF-16, as Excel saves "Unicode text": a NUL byte after each letter.
    const utf16 = Buffer.from(fitted("Chart,A"), "utf16le");
    expect(await fileError(utf16)).toBe(SAVE_AS);
  });

  it("refuses an empty file", async () => {
    expect(await fileError("")).toBe("The file is empty.");
    expect(await fileError(`${BOM}\r\n,,\r\n`)).toBe("The file is empty.");
    expect(await fileError(null)).toBe("The file is empty.");
  });

  it("refuses a quote that never closes, naming its row", async () => {
    const csv = fitted("Chart,A,tops,in,1", 'Table,t1,"Tops', "Row,a,S");
    expect(await fileError(csv)).toBe('Row 3: A quote (") is never closed.');
  });

  it("refuses files it can't place", async () => {
    expect(await fileError("Fitted size charts,2\nChart,A")).toBe(
      "Row 1: Fitted can't read this CSV version.",
    );
    expect(await fileError(fitted("", "Table,t1"))).toBe(
      "Row 3: Put a Chart row above this row.",
    );
    const other =
      "Fitted can only read its own CSV export for now, with commas between cells.";
    expect(await fileError("Size,Chest\nS,34")).toBe(other);
    // Text that merely starts with PK is no zip.
    expect(await fileError("PKG,Chest\nS,34")).toBe(other);
  });
});
