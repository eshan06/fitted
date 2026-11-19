import { describe, expect, it } from "vitest";
import { validateChart } from "./chart.server";
import { exportCsv } from "./csv-import.server";

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
  ["﻿Fitted size charts,1", ...rows, ""].join("\r\n");
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
        "Row,l,'+L,,,,,'quoted",
        "Merge,s,fitnote,3,1",
        "Wrap,fitnote",
        // An apostrophe that already leads a formula start gets one more.
        "Table,t2,''=Kids,,",
        "Columns,,sz:size,uk:UK",
        "Labels,,,",
        "Row,a,2T – 3T,ñ 中 😀",
        "Text,m.bust.name,Bust",
        "Text,m.bust.text,Around the fullest part",
        `Text,tips,"Measure over light clothing.\n\nAsk us anytime."`,
        "Text,fit.q1,Your chest?",
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
