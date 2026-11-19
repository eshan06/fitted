import { readFileSync } from "node:fs";
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

  it("generates a blank row id that no other part of the chart uses", async () => {
    const fit =
      '""fit"":{""table"":""t1"",""questions"":[{""id"":""r2"",""kind"":""fit""}],""ease"":{},""stretch"":""none""}';
    const csv = fitted(
      "Chart,Shirts,tops,in,1",
      `Settings,"{""measure"":{""steps"":[""r1""]},${fit}}"`,
      "Table,t1",
      "Columns,,s:size,c:in",
      "Row,,S,34",
      "Row,r3,M,36",
      "Table,t2",
      "Columns,,z:size",
      "Row,r4,X",
      "Row,,Y",
    );
    const [draft] = await drafts(csv);
    const ids = (t: number) =>
      draft.status === "ready" && draft.content.tables[t].rows.map((r) => r.id);
    expect([ids(0), ids(1)]).toEqual([
      ["r5", "r3"],
      ["r4", "r6"],
    ]);
    expect(draft.status === "ready" && draft.content.words).toMatchObject({
      "t1.r5.s": "S",
      "t2.r6.z": "Y",
    });
    // Table and column ids typed in the file are taken too.
    const typed = fitted(
      "Chart,Shirts,tops,in,1",
      "Table,r1",
      "Columns,,s:size,,c1:text",
      "Row,,S,34,x",
    );
    const [t] = await drafts(typed);
    expect(t.status === "ready" && t.content.tables[0]).toMatchObject({
      columns: [{ id: "s" }, { id: "c2" }, { id: "c1" }],
      rows: [{ id: "r2" }],
    });
  });

  it("infers a column with no type, as in a spreadsheet", async () => {
    const csv = fitted(
      "Chart,Shirts,tops,cm,1",
      "Table,t1",
      "Columns,,s:size,,chest:,us:US,hips",
      "Labels,,Size,Waist (in),Chest,,Hips",
      "Row,a,S,30,86-90,4,94",
    );
    const [draft] = await drafts(csv);
    expect(draft.status === "ready" && draft.content.tables[0]).toEqual({
      id: "t1",
      columns: [
        { id: "s", kind: "size" },
        { id: "c1", kind: "measure", unit: "in", convert: true },
        { id: "chest", kind: "measure", convert: true },
        { id: "us", kind: "country", country: "US" },
        { id: "hips", kind: "measure", convert: true },
      ],
      rows: [{ id: "a", cells: { c1: [30], chest: [86, 90], hips: [94] } }],
    });
    expect(draft.status === "ready" && draft.content.words).toEqual({
      "t1.s": "Size",
      "t1.c1": "Waist",
      "t1.chest": "Chest",
      "t1.hips": "Hips",
      "t1.a.s": "S",
      "t1.a.us": "4",
    });
    // With no Columns row at all, every column is inferred.
    const bare = fitted("Chart,R,rings,cm,1", "Table,r", "Row,x,5,1.5,Gold");
    const [ring] = await drafts(bare);
    expect(ring.status === "ready" && ring.content.tables[0].columns).toEqual([
      { id: "c1", kind: "size" },
      { id: "c2", kind: "measure", convert: true },
      { id: "c3", kind: "text" },
    ]);
  });

  it("reads an export a spreadsheet saved with semicolons and decimal commas", async () => {
    const csv = [
      "Fitted size charts;1",
      "Chart;Rings;rings;cm;0,25",
      "Table;r",
      "Columns;;s:size;dia:measure:fixed",
      "Row;r0;5;1,5 - 2",
    ].join("\n");
    const [draft] = await drafts(csv);
    expect(draft.status === "ready" && draft.content).toMatchObject({
      roundTo: 0.25,
      tables: [{ rows: [{ cells: { dia: [1.5, 2] } }] }],
    });
  });

  it("reads a unit in a measure cell only when it is the column's", async () => {
    const top = ["Chart,Shirts,tops,in,1", "Table,t1"];
    const cols = "Columns,,s:size,c:measure,w:kg";
    const [draft] = await drafts(fitted(...top, cols, 'Row,a,S,34 in,"60kg"'));
    expect(draft.status === "ready" && draft.content.tables[0].rows).toEqual([
      { id: "a", cells: { c: [34], w: [60] } },
    ]);
    expect(await reasonOf(fitted(...top, cols, "Row,a,S,86 cm,130 lbs"))).toBe(
      "Row 5, column D: Give this in inches, like the rest of its column; " +
        "Row 5, column E: Give this in kilograms, like the rest of its column.",
    );
  });
});

describe("importing a spreadsheet", () => {
  const sheet = (csv: string, fileName = "Shirts.csv") =>
    importCsv(stream(csv), fileName).then(([draft]) => draft);
  const sheetReason = async (csv: string) => {
    const draft = await sheet(csv);
    expect(draft.status).toBe("unreadable");
    return draft.status === "unreadable" ? draft.reason : "";
  };
  const CHECK =
    "The file doesn't say whether the measurements are in inches or centimeters.";

  it("reads Fitted's template as a ready chart named after the file", async () => {
    const csv = readFileSync("public/fitted-template.csv", "utf8");
    const m = (id: string) => ({
      id,
      kind: "measure",
      unit: "in",
      convert: true,
    });
    const sizes = [
      ["XS", [31, 32], [24, 25], [34, 35]],
      ["S", [33, 34], [26, 27], [36, 37]],
      ["M", [35, 36], [28, 29], [38, 39]],
      ["L", [37.5, 39], [30.5, 32], [40.5, 42]],
      ["XL", [40.5, 42], [33.5, 35], [43.5, 45]],
    ] as const;
    expect(await sheet(csv, "fitted-template.csv")).toEqual(
      ready({
        name: "fitted-template",
        template: "blank",
        content: {
          v: 1,
          unit: "in",
          roundTo: 0.5,
          tables: [
            {
              id: "t1",
              columns: [{ id: "c1", kind: "size" }, m("c2"), m("c3"), m("c4")],
              rows: sizes.map(([, bust, waist, hips], i) => ({
                id: `r${i + 1}`,
                cells: { c2: bust, c3: waist, c4: hips },
              })),
            },
          ],
          measure: { steps: [] },
          words: {
            "t1.c1": "Size",
            "t1.c2": "Bust",
            "t1.c3": "Waist",
            "t1.c4": "Hips",
            ...Object.fromEntries(
              sizes.map(([size], i) => [`t1.r${i + 1}.c1`, size]),
            ),
          },
        },
      }),
    );
  });

  it("reads each column's kind and unit from its label and cells", async () => {
    const csv = [
      'Size,US,Chest (cm),Waist cm,"Hips, cm",Inseam [in],Weight (lbs),Height,Fit',
      "S,4,86-90,70 cm,94,30,120 to 130,160 cm,Relaxed",
      "M,6,90-94,74,98,30.5,130–140,165,Slim",
    ].join("\r\n");
    const draft = await sheet(csv);
    const m = (id: string, unit?: string) => ({
      id,
      kind: "measure",
      ...(unit && { unit }),
      convert: true,
    });
    // Four length columns are in cm and one in inches, so the chart is in cm.
    expect(draft.status === "ready" && draft.content.unit).toBe("cm");
    expect(draft.status === "ready" && draft.content.tables[0].columns).toEqual(
      [
        { id: "c1", kind: "size" },
        { id: "c2", kind: "country", country: "US" },
        m("c3", "cm"),
        m("c4", "cm"),
        m("c5", "cm"),
        m("c6", "in"),
        m("c7", "lb"),
        m("c8", "cm"),
        { id: "c9", kind: "text" },
      ],
    );
    expect(draft.status === "ready" && draft.content.words).toMatchObject({
      "t1.c2": "US",
      "t1.c3": "Chest",
      "t1.c4": "Waist",
      "t1.c5": "Hips",
      "t1.c6": "Inseam",
      "t1.c7": "Weight",
      "t1.c8": "Height",
      "t1.r2.c9": "Slim",
    });
    expect(draft.status === "ready" && draft.content.tables[0].rows[0]).toEqual(
      {
        id: "r1",
        cells: {
          c3: [86, 90],
          c4: [70],
          c5: [94],
          c6: [30],
          c7: [120, 130],
          c8: [160],
        },
      },
    );
  });

  it("asks to check the units when no label or cell names a length unit", async () => {
    const draft = await sheet("Size,Chest,Weight (kg)\nS,34-36,60\nM,36,");
    expect(draft).toMatchObject({ status: "check_units", reason: CHECK });
    expect(draft.status === "check_units" && draft.content.tables[0]).toEqual({
      id: "t1",
      columns: [
        { id: "c1", kind: "size" },
        { id: "c2", kind: "measure", convert: true },
        { id: "c3", kind: "measure", unit: "kg", convert: true },
      ],
      rows: [
        { id: "r1", cells: { c2: [34, 36], c3: [60] } },
        { id: "r2", cells: { c2: [36] } },
      ],
    });
    // Nothing to measure, or only weights, is nothing to check.
    for (const csv of ["US,UK,EU\n4,8,36", "Size,Weight (kg)\nS,60"])
      expect(await sheet(csv)).toMatchObject({ status: "ready" });
    // As many lengths in cm as in inches: inches.
    const tie = await sheet("Size,Chest (cm),Waist (in)\nS,86,28");
    expect(tie.status === "ready" && tie.content.unit).toBe("in");
  });

  it("reads every common spelling of a unit", async () => {
    const labels = [
      "Size",
      "A (inches)",
      "B ins",
      "C (centimetres)",
      "D centimeter",
      "E (lbs.)",
      "F pounds",
      '"G, kilograms"',
      "H [kgs]",
      // These two take their units from their cells.
      "I",
      "J",
    ];
    const csv = `${labels}\nS,1,2,3,4,5,6,7,8,"9""",10 Kilos.`;
    const draft = await sheet(csv);
    const units = ["in", "in", "cm", "cm", "lb", "lb", "kg", "kg", "in", "kg"];
    expect(draft.status === "ready" && draft.content.tables[0].columns).toEqual(
      [
        { id: "c1", kind: "size" },
        ...units.map((unit, i) => ({
          id: `c${i + 2}`,
          kind: "measure",
          unit,
          convert: true,
        })),
      ],
    );
    expect(draft.status === "ready" && draft.content.words).toMatchObject(
      Object.fromEntries(
        "ABCDEFGHIJ".split("").map((l, i) => [`t1.c${i + 2}`, l]),
      ),
    );
  });

  it("refuses a column in a unit Fitted can't hold, instead of guessing", async () => {
    // A unit alone is no name, though: G stays a column called G.
    const g = await sheet("Size,Chest (in),G\nS,34,3");
    expect(g.status === "ready" && g.content.words["t1.c3"]).toBe("G");
    expect(await sheetReason("Size,Diameter (mm),Weight g\nS,16,3")).toBe(
      "Row 1, Diameter (mm): Convert this column to inches, centimeters, pounds or kilograms; " +
        "Row 1, Weight g: Convert this column to inches, centimeters, pounds or kilograms.",
    );
  });

  it("reads a size system or an age as text, never as a length", async () => {
    const csv = [
      "Size,us sizes,Size UK,EUR,AU/NZ,IT,JP,Age (years),Chest (cm)",
      "S,4,8,36,8,40,7,2-3,86",
    ].join("\n");
    const draft = await sheet(csv);
    const country = (id: string, c: string) => ({
      id,
      kind: "country",
      country: c,
    });
    expect(draft.status === "ready" && draft.content.tables[0].columns).toEqual(
      [
        { id: "c1", kind: "size" },
        country("c2", "US"),
        country("c3", "UK"),
        country("c4", "EU"),
        country("c5", "AU"),
        { id: "c6", kind: "text" },
        { id: "c7", kind: "text" },
        { id: "c8", kind: "text" },
        { id: "c9", kind: "measure", unit: "cm", convert: true },
      ],
    );
  });

  it("makes a column of mostly numbers a measure column, and a dash no value", async () => {
    // Notes: half numbers. Gap: empty. Neither is mostly numbers.
    const csv =
      "Size,Chest (in),Notes,Waist,Gap\nS,34,Runs small,28\nM,—,36,–\nL,-,Slim,30";
    const draft = await sheet(csv);
    expect(draft.status).toBe("ready");
    expect(draft.status === "ready" && draft.content.tables[0]).toEqual({
      id: "t1",
      columns: [
        { id: "c1", kind: "size" },
        { id: "c2", kind: "measure", unit: "in", convert: true },
        { id: "c3", kind: "text" },
        { id: "c4", kind: "measure", convert: true },
        { id: "c5", kind: "text" },
      ],
      rows: [
        { id: "r1", cells: { c2: [34], c4: [28] } },
        { id: "r2", cells: {} },
        { id: "r3", cells: { c4: [30] } },
      ],
    });
  });

  it("reads semicolons with decimal commas, and tabs", async () => {
    const semi = await sheet(
      'Size;"Chest; relaxed (cm)";Waist, in\nS;86,5-90;28,5',
    );
    expect(semi.status === "ready" && semi.content.tables[0]).toMatchObject({
      columns: [{}, { unit: "cm" }, { unit: "in" }],
      rows: [{ cells: { c2: [86.5, 90], c3: [28.5] } }],
    });
    expect(semi.status === "ready" && semi.content.words["t1.c2"]).toBe(
      "Chest; relaxed",
    );
    const tab = await sheet(
      "Size\tChest (in)\tFit, notes\nS\t34.5\tSnug, short",
    );
    expect(tab.status === "ready" && tab.content.words).toMatchObject({
      "t1.c3": "Fit, notes",
      "t1.r1.c3": "Snug, short",
    });
    // A decimal comma needs semicolons: with commas, it's no number.
    expect(await sheetReason('Size,Chest (in)\nS,"34,5"')).toBe(
      "Row 2, Chest (in): Use a number like 34.5 or a range like 34–36.",
    );
  });

  it("picks the delimiter the first row with text uses most outside quotes", async () => {
    const chest = async (csv: string) => {
      const draft = await sheet(csv);
      return draft.status === "ready" && draft.content.tables[0].rows[0];
    };
    // Delimiters inside quotes don't count, even ones another delimiter
    // would leave outside them.
    for (const csv of [
      'Size,"Chest; relaxed, cm"\nS,86',
      '"Size","Chest; a; b (cm)"\nS,86',
      'Size,"Chest\tcm"\nS,86',
      // A blank row first, and a tie, which goes to the semicolon.
      "\r\n;;\r\nSize;Chest, cm\nS;86",
    ])
      expect(await chest(csv)).toEqual({ id: "r1", cells: { c2: [86] } });
  });

  it("names the row and column of each bad cell", async () => {
    const csv = "Size,Chest (in),Waist\nS,86 cm,abc\nM,36,28\nL,38,30";
    expect(await sheetReason(csv)).toBe(
      "Row 2, Chest (in): Give this in inches, like the rest of its column; " +
        "Row 2, Waist: Use a number like 34.5 or a range like 34–36.",
    );
    const long = "x".repeat(501);
    expect(await sheetReason(`Size,${long}\nS,y`)).toBe(
      "Row 1, column B: Must be text of at most 500 characters.",
    );
  });

  it("refuses a table without sizes, or of more than 60 rows or 20 columns", async () => {
    expect(await sheetReason("Size,Chest (in)")).toBe(
      "Row 1: A table needs 1 to 60 size rows.",
    );
    const rows = Array.from({ length: 70 }, (_, i) => `S${i},34`);
    expect(await sheetReason(["Size,Chest (in)", ...rows].join("\n"))).toBe(
      "Row 62: A table needs 1 to 60 size rows.",
    );
    const wide = Array.from({ length: 21 }, (_, i) => `C${i}`).join(",");
    expect(await sheetReason(`${wide}\nS`)).toBe(
      "Row 1: A table needs 1 to 20 columns.",
    );
  });

  it("names the chart after the file, on one line of at most 100 characters", async () => {
    const name = async (fileName: string) =>
      (await sheet("Size\nS", fileName)).name;
    const nul = String.fromCharCode(0);
    expect(await name(`  Women's\ttops${nul}v2.csv `)).toBe("Women's tops v2");
    expect(await name("tops.2026.csv")).toBe("tops.2026");
    for (const blank of ["", ".csv", " \n.csv"])
      expect(await name(blank)).toBe("Imported chart");
    // Cut at 100, never through the middle of an emoji.
    const smile = String.fromCodePoint(0x1f600);
    expect(await name(`${"a".repeat(99)}${smile}.csv`)).toBe("a".repeat(99));
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

  it("reports text in a cell Fitted doesn't read instead of dropping it", async () => {
    const unread = "This row has text in a cell Fitted doesn't read";
    const csv = fitted(
      "Chart,Shirts,tops,in,1,extra",
      'Settings,"{""measure"":{""steps"":[]}}",extra',
      "Table,t1,Tops,,,extra",
      "Columns,,s:size,c:text",
      "Labels,Size,Notes",
      "Row,a,S",
      "Merge,a,s,1,1,extra",
      "Text,tips,Measure over light clothing, not a coat",
    );
    expect(await reasonOf(csv)).toBe(
      [2, 3, 4, 6, 8].map((n) => `Row ${n}: ${unread}`).join("; ") +
        "; and 1 more.",
    );
    expect(await reasonOf(fitted("Chart,A,tops,in,1,x", "Text,a,b,c"))).toMatch(
      `Row 2: ${unread}; Row 2: A chart needs 1 to 4 tables; Row 3: ${unread}`,
    );
  });

  it("reads a Wrap row's ids past blank cells, and places one over 20", async () => {
    const top = ["Chart,A,tops,in,1", "Table,t1", "Columns,,s:size,c:text"];
    const [draft] = await drafts(
      fitted(...top, "Row,a,S", `Wrap,s${",".repeat(21)}c`),
    );
    expect(draft.status === "ready" && draft.content.tables[0].wrap).toEqual([
      "s",
      "c",
    ]);
    expect(
      await reasonOf(fitted(...top, "Row,a,S", `Wrap${",s".repeat(21)}`)),
    ).toBe("Row 6: Must have 0 to 20 items.");
  });

  // A long id copied into every key built from it would make each of them
  // as long, and V8 hashes strings past 16,383 characters by length alone.
  it("reads long table and column ids in linear time", async () => {
    const cols = Array.from({ length: 19 }, (_, i) => `c${i}:text`);
    const rows = Array.from(
      { length: 60 },
      (_, i) => `Row,r${i},${Array(20).fill("x")}`,
    );
    const long = "t".repeat(50_000);
    for (const [table, first] of [
      [long, "s"],
      ["t1", "s".repeat(900_000)],
    ]) {
      const csv = fitted(
        "Chart,A,tops,in,1",
        `Table,${table}`,
        `Columns,,${first}:size,${cols}`,
        ...rows,
      );
      const start = Date.now();
      expect(await reasonOf(csv)).toMatch(
        /^Row \d(, column C)?: Use 1 to 8 lowercase letters or digits; /,
      );
      expect(Date.now() - start).toBeLessThan(1000);
    }
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
    // Not Fitted's keys, not an object, and cut short as Excel cuts long cells.
    for (const json of [
      '"{""tables"":[],""words"":{}}"',
      "[]",
      '"{""fit"":{"',
    ]) {
      const csv = fitted(
        "Chart,Shirts,tops,in,1",
        `Settings,${json}`,
        "Table,t1",
        "Columns,,s:size",
        "Row,a,S",
      );
      expect(await reasonOf(csv)).toBe(
        "Row 3: This Settings row isn't in the form Fitted writes.",
      );
    }
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
  // Charts of four tables, each with no Columns row and 20 labels that make
  // a unit search backtrack, so every label is searched.
  const label = `${"(".repeat(32)}in${" ".repeat(60)}x`;
  const padded = ["", "Chart,A,tops,in,1"]
    .concat(
      ...[1, 2, 3, 4].map((t) => [
        `Table,t${t}`,
        `Labels,,${Array(20).fill(label)}`,
        "Row,a,S",
      ]),
    )
    .join("\n");
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
    [
      "settings nested deep",
      fitted(...chart, 'Settings,"{""measure"":'),
      "[",
      '"',
    ],
    ["settings keys full of dots", fitted(), dotted, ""],
    ["one wide Wrap row", fitted(...chart, "Row,a,S", "Wrap"), ",s", ""],
    // Spreadsheets, which each delimiter is tried on.
    ["a padded label", 'Size,"', " ", 'x in"\nS,1'],
    ["a wide first row of semicolons", "Size", ";", ""],
    ["a quote only commas open", 'Size;x,"', "a;", ""],
    ["many size rows", "Size,Chest (in)", "\nS,1", ""],
    ["a measure cell of spaces", 'Size,Chest\nS,"1', " ", 'x"'],
    ["decimal commas", "Size;Chest\nS;1", ",", ""],
    ["many padded labels in untyped columns", fitted(), padded, ""],
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
    // Text that merely starts with PK is no zip, but a spreadsheet.
    await expect(drafts("PKG,Chest (in)\nS,34")).resolves.toMatchObject([
      { status: "ready" },
    ]);
  });
});
