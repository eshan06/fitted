// CSV of size charts in Fitted's own layout, which ARCHITECTURE §13 records.
// Export writes every part of a chart, so importing the file brings it back
// unchanged. Import is a trust boundary, served by one instance (§17): every
// cell is checked, and every step runs in linear time on any input.
import {
  type ChartInput,
  ChartValidationError,
  type Column,
  type Content,
  type Table,
  type Template,
  validateChart,
} from "./chart.server";

const MARK = "Fitted size charts";
// Spreadsheets run a cell starting with = + - @, a tab or a carriage return as
// a formula, and some start cells at a semicolon, tab or line break too. Export
// puts an apostrophe at each such start, even before quotes or apostrophes
// already there, so import can take one off and get the text back exactly.
const FORMULA = /(?<=^|[;\t\r\n])(?=['"]*[=+\-@\t\r])/g;
const UNFORMULA = /(?<=^|[;\t\r\n])'(?=['"]*[=+\-@\t\r])/g;
// No text is an empty cell and an empty text is "", and text with spaces
// around it is quoted, so import can tell them apart and keep the spaces.
const csvCell = (v?: string) => {
  if (v === undefined) return "";
  const s = v.replace(FORMULA, "'");
  return s === "" || /[",\r\n]|^\s|\s$/.test(s)
    ? `"${s.replaceAll('"', '""')}"`
    : s;
};
const typeOf = (c: Column) =>
  c.kind === "country"
    ? c.country
    : c.kind === "measure"
      ? `${c.unit ?? "measure"}${c.convert ? "" : ":fixed"}`
      : c.kind;

export function exportCsv(charts: { name: string; chart?: ChartInput }[]) {
  const out: (string | undefined)[][] = [[MARK, "1"]];
  const add = (...cells: (string | undefined)[]) => out.push(cells);
  for (const { name, chart } of charts) {
    if (!chart) {
      // Never dropped silently (§5): named, and importing says why it's empty.
      add("Chart", name);
      add("Error", "This chart has errors in Fitted");
      continue;
    }
    const c = chart.content;
    const used = new Set<string>();
    const word = (key: string) => (used.add(key), c.words[key]);
    add("Chart", chart.name, chart.template, c.unit, `${c.roundTo}`);
    const { measure, videoUrl, fit } = c;
    add("Settings", JSON.stringify({ measure, videoUrl, fit }));
    for (const t of c.tables) {
      const { id, columns: cols } = t;
      add(
        "Table",
        id,
        ...["title", "sub", "note"].map((k) => word(`${id}.${k}`)),
      );
      add("Columns", undefined, ...cols.map((k) => `${k.id}:${typeOf(k)}`));
      add("Labels", undefined, ...cols.map((k) => word(`${id}.${k.id}`)));
      for (const r of t.rows) {
        const cell = (k: Column) =>
          k.kind === "measure"
            ? r.cells[k.id]?.join("–")
            : word(`${id}.${r.id}.${k.id}`);
        add("Row", r.id, ...cols.map(cell));
      }
      for (const m of t.merges ?? [])
        add("Merge", m.row, m.col, `${m.rows}`, `${m.cols}`);
      if (t.wrap?.length) add("Wrap", ...t.wrap);
    }
    for (const [key, text] of Object.entries(c.words))
      if (!used.has(key)) add("Text", key, text);
  }
  // The BOM makes Excel read the file as UTF-8.
  return `\uFEFF${out.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

// Bounds that keep a file's work small: 1 MB holds several hundred exported
// charts, and Fitted writes a chart in at most about 5,200 rows.
export const CSV_MAX_BYTES = 1024 * 1024;
const MAX_CHARTS = 1000;
const MAX_ROWS = 6000;
const SPLIT =
  "To split a Fitted export, copy its first row to the top of each file and split only above a Chart row.";

// What every import source hands the import flow (§13).
export type ChartDraft = { name: string; products: string[] } & (
  | { status: "ready"; template: Template; content: Content }
  | {
      status: "check_units";
      template: Template;
      content: Content;
      reason: string;
    }
  | { status: "unreadable"; reason: string }
);

// A problem with the whole file. Its message is written for the merchant.
export class CsvFileError extends Error {}

// The upload as the raw request body, streamed and cut off at the cap. A bad
// chart becomes an `unreadable` draft; only a file it can't read throws.
export async function importCsv(
  body: ReadableStream<Uint8Array> | null,
): Promise<ChartDraft[]> {
  const rows = records(await readText(body));
  const first = rows.next();
  if (first.done) throw new CsvFileError("The file is empty.");
  const { line, cells } = first.value;
  if (cells[0] !== MARK)
    throw new CsvFileError(
      "This isn't a CSV that Fitted exported, and Fitted can't read other spreadsheets yet.",
    );
  if (cells[1] !== "1")
    throw new CsvFileError(
      `Row ${line}: Fitted can't read this version of its CSV.`,
    );
  // A chart at a time, so only one chart's rows are held.
  const drafts: ChartDraft[] = [];
  let chart: Rec[] | undefined;
  for (const r of rows)
    if (r.cells[0] === "Chart") {
      if (chart) drafts.push(fittedChart(chart));
      if (drafts.length === MAX_CHARTS)
        throw new CsvFileError(
          `The file has more than 1,000 charts. Split it into files of at most 1,000 charts and upload each one. ${SPLIT}`,
        );
      chart = [r];
    } else if (!chart)
      throw new CsvFileError(`Row ${r.line}: Put a Chart row above this row.`);
    // Rows past the cap are only counted: the chart is too large to read.
    else if (chart.length <= MAX_ROWS) chart.push(r);
  if (!chart) throw new CsvFileError("The file has no charts.");
  drafts.push(fittedChart(chart));
  return drafts;
}

const SAVE_AS =
  "This isn't a UTF-8 CSV file. Save it from your spreadsheet app as CSV UTF-8, then upload that.";

async function readText(body: ReadableStream<Uint8Array> | null) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CSV_MAX_BYTES) {
      await reader.cancel();
      throw new CsvFileError(
        `The file is over 1 MB. Split it into smaller files and upload each one. ${SPLIT}`,
      );
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  // No magic number marks a CSV: refuse NUL bytes (binary, UTF-16), zips, PDFs.
  if (bytes.includes(0) || /^(PK|%PDF)/.test(bytes.toString("latin1", 0, 4)))
    throw new CsvFileError(SAVE_AS);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes); // drops a BOM
  } catch {
    throw new CsvFileError(SAVE_AS);
  }
}

// Rows of cells as a spreadsheet numbers them, blank rows skipped. Unquoted
// cells are trimmed (empty is undefined: no text); quoted ones keep exactly
// what's inside the quotes. One pass of slices, no regex or growing string.
type Rec = { line: number; cells: (string | undefined)[] };
const ends = (ch: string | undefined) =>
  ch === undefined || ch === "," || ch === "\r" || ch === "\n";
function* records(text: string): Generator<Rec, void, undefined> {
  let cells: (string | undefined)[] = [];
  let line = 1;
  for (let i = 0; ;) {
    let j = i;
    while (text[j] === " ") j++;
    let cell: string | undefined;
    if (text[j] === '"') {
      let k = j + 1;
      for (; ; k += 2) {
        k = text.indexOf('"', k);
        if (k < 0)
          throw new CsvFileError(`Row ${line}: A quote (") is never closed.`);
        if (text[k + 1] !== '"') break;
      }
      i = k + 1;
      while (!ends(text[i])) i++;
      cell =
        text.slice(j + 1, k).replaceAll('""', '"') +
        text.slice(k + 1, i).trimEnd();
    } else {
      i = j;
      while (!ends(text[i])) i++;
      cell = text.slice(j, i).trim() || undefined;
    }
    cells.push(cell?.replace(UNFORMULA, ""));
    if (text[i++] === ",") continue;
    // A line break or the end: past the end, i is beyond the text.
    if (cells.some((c) => c !== undefined)) yield { line, cells };
    if (i > text.length) return;
    if (text[i - 1] === "\r" && text[i] === "\n") i++;
    cells = [];
    line++;
  }
}

type Where = { line: number; col?: string };
type Cell = [number] | [number, number];

// One chart's parse: its words, its problems by row, and the row each field
// path came from, so validateChart's errors point at rows of the file.
class Draft {
  words = new Map<string, string>();
  at = new Map<string, Where>();
  errors: { line: number; col?: string; text: string }[] = [];
  reported = new Set<string>();
  constructor(readonly head: Rec) {}
  // `path` is reported here in CSV terms, so validateChart's error on it isn't.
  fail({ line, col }: Where, text: string, path?: string) {
    this.errors.push({ line, col, text });
    if (path) this.reported.add(path);
  }
  word(key: string, text: string | undefined, w: Where) {
    if (text === undefined) return;
    if (this.words.has(key)) return this.fail(w, "This text is given twice");
    this.words.set(key, text);
    this.at.set(`content.words.${key}`, w);
  }
  finish(input: { name: string; template: unknown; content: object }) {
    let chart: ChartInput | undefined;
    try {
      const words = Object.fromEntries(this.words);
      chart = validateChart({ ...input, content: { ...input.content, words } });
    } catch (err) {
      if (!(err instanceof ChartValidationError)) throw err;
      for (const [path, text] of Object.entries(err.fieldErrors)) {
        if (this.reported.has(path)) continue;
        let p = path;
        while (p && !this.at.has(p))
          p = p.slice(0, Math.max(0, p.lastIndexOf(".")));
        this.fail(this.at.get(p) ?? this.head, text);
      }
    }
    if (!chart || this.errors.length)
      return unreadable(input.name, this.errors);
    const { name, template, content } = chart;
    return { name, template, content, products: [], status: "ready" as const };
  }
}

function unreadable(name: string, errors: Draft["errors"]): ChartDraft {
  const errs = errors
    .sort((a, b) => a.line - b.line)
    .map((e) => `Row ${e.line}${e.col ? `, ${e.col}` : ""}: ${e.text}`);
  const more = errs.length > 5 ? `; and ${errs.length - 5} more` : "";
  return {
    name: name.trim() || "Untitled chart",
    products: [],
    status: "unreadable",
    reason: `${errs.slice(0, 5).join("; ")}${more}.`,
  };
}

// Each part matches one way only, so a hostile cell can't make it backtrack.
const NUM = String.raw`((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)`;
const VALUE = new RegExp(`^${NUM}(?:\\s*(?:-|–|—|to)\\s*${NUM})?$`, "i");
const SPEC =
  /^([^:]*):(?:(size|text)|(US|UK|EU|AU)|(measure|in|cm|lb|kg)(:fixed)?)$/;
type Country = Extract<Column, { kind: "country" }>["country"];
type Unit = NonNullable<Extract<Column, { kind: "measure" }>["unit"]>;

// One table: its Table row, then the rows that belong to it.
type Grid = { at: Rec; rows: Rec[]; merges: Rec[] } & {
  [K in (typeof KEY)[keyof typeof KEY]]?: Rec;
};
function table(d: Draft, ti: number, g: Grid): Table {
  const p = `content.tables.${ti}`;
  const tid = g.at.cells[1] ?? "";
  d.at.set(p, g.at);
  if (g.rows.length < 1 || g.rows.length > 60)
    d.fail(g.rows[60] ?? g.at, "A table needs 1 to 60 size rows", `${p}.rows`);
  const rows = g.rows.slice(0, 60); // the rest are reported above
  rows.forEach((r, ri) => d.at.set(`${p}.rows.${ri}`, r));
  // Spreadsheets pad rows with empty cells, so trailing ones don't count.
  const width = (r?: Rec) => {
    let n = r?.cells.length ?? 0;
    while (n > 2 && r?.cells[n - 1] === undefined) n--;
    return n - 2;
  };
  const n = Math.max(0, width(g.types), width(g.labels), ...rows.map(width));
  const head = g.types ?? g.at;
  if (n < 1 || n > 20)
    d.fail(head, "A table needs 1 to 20 columns", `${p}.columns`);
  const columns: Column[] = [];
  const cells = rows.map(() => new Map<string, Cell>());
  for (let j = 0; j < Math.min(n, 20); j++) {
    const cell = (r?: Rec) => r?.cells[j + 2];
    const label = cell(g.labels);
    // Named by its label in reasons, or its letter when that is blank or long.
    const shown = label?.trim();
    const col =
      shown && shown.length <= 40
        ? shown
        : `column ${String.fromCharCode(67 + j)}`;
    const m = SPEC.exec(cell(g.types) ?? "");
    if (!m) {
      d.fail(
        { line: head.line, col },
        "Fitted doesn't know this column's type",
      );
      continue;
    }
    const [, id, kind, country, unit, fixed] = m;
    const column: Column = kind
      ? { id, kind: kind as "size" | "text" }
      : country
        ? { id, kind: "country", country: country as Country }
        : {
            id,
            kind: "measure",
            ...(unit !== "measure" && { unit: unit as Unit }),
            convert: !fixed,
          };
    d.at.set(`${p}.columns.${columns.push(column) - 1}`, {
      line: head.line,
      col,
    });
    d.word(`${tid}.${id}`, label, { line: (g.labels ?? head).line, col });
    rows.forEach((r, ri) => {
      const w = { line: r.line, col };
      const v = cell(r);
      if (column.kind !== "measure")
        return d.word(`${tid}.${r.cells[1] ?? ""}.${id}`, v, w);
      if (v === undefined) return;
      const num = VALUE.exec(v);
      if (!num)
        return d.fail(w, "Use a number like 34.5 or a range like 34–36");
      cells[ri].set(id, num[2] === undefined ? [+num[1]] : [+num[1], +num[2]]);
      d.at.set(`${p}.rows.${ri}.cells.${id}`, w);
    });
  }
  const out: Table = {
    id: tid,
    columns,
    rows: rows.map((r, ri) => ({
      id: r.cells[1] ?? "",
      cells: Object.fromEntries(cells[ri]),
    })),
  };
  g.merges.forEach((m, mi) => d.at.set(`${p}.merges.${mi}`, m));
  if (g.merges.length)
    out.merges = g.merges.map(({ cells: [, row = "", col = "", r, c] }) => ({
      row,
      col,
      rows: Number(r),
      cols: Number(c),
    }));
  const wrap =
    g.wrap?.cells.slice(1).filter((w): w is string => w !== undefined) ?? [];
  wrap.forEach((_, wi) => d.at.set(`${p}.wrap.${wi}`, g.wrap!));
  if (wrap.length) out.wrap = wrap;
  return out;
}

// Rows a table holds once, by the Grid key each fills.
const KEY = { Columns: "types", Labels: "labels", Wrap: "wrap" } as const;
const SETTINGS = ["measure", "videoUrl", "fit"];

// One chart of Fitted's layout: its Chart row, then the rows that belong to it.
function fittedChart([head, ...rest]: Rec[]): ChartDraft {
  const name = head.cells[1] ?? "";
  const d = new Draft(head);
  const broken = rest.find((r) => r.cells[0] === "Error");
  if (rest.length === MAX_ROWS)
    d.fail(
      rest[MAX_ROWS - 1],
      "The chart is too large; split it into smaller charts",
    );
  else if (broken)
    d.fail(
      broken,
      "This chart had errors in Fitted when the file was made, so the file has only its name",
    );
  if (d.errors.length) return unreadable(name, d.errors);
  const grids: Grid[] = [];
  let settings: Record<string, unknown> | undefined;
  for (const r of rest) {
    const [kind = "", b, c] = r.cells;
    const t = grids.at(-1);
    if (kind === "Table") {
      grids.push({ at: r, rows: [], merges: [] });
      // Tables past the fourth are reported below, not read.
      if (grids.length <= 4)
        ["title", "sub", "note"].forEach((k, i) =>
          d.word(`${b ?? ""}.${k}`, r.cells[i + 2], r),
        );
    } else if (kind === "Settings" && !settings) {
      let s: unknown;
      try {
        s = JSON.parse(b ?? "");
      } catch {
        // reported below
      }
      const ok =
        typeof s === "object" &&
        s !== null &&
        !Array.isArray(s) &&
        Object.keys(s).every((k) => SETTINGS.includes(k));
      if (!ok) d.fail(r, "This Settings row isn't in the form Fitted writes");
      settings = ok ? (s as Record<string, unknown>) : {};
      SETTINGS.forEach((k) => d.at.set(`content.${k}`, r));
    } else if (kind === "Text") d.word(b ?? "", c, r);
    else if (t && kind === "Row") t.rows.push(r);
    else if (t && kind === "Merge") t.merges.push(r);
    else if (t && Object.hasOwn(KEY, kind) && !t[KEY[kind as keyof typeof KEY]])
      t[KEY[kind as keyof typeof KEY]] = r;
    else
      d.fail(
        r,
        !t && (Object.hasOwn(KEY, kind) || kind === "Row" || kind === "Merge")
          ? "Put a Table row above this row"
          : "Fitted doesn't expect this row here",
      );
  }
  if (grids.length < 1 || grids.length > 4)
    d.fail(
      grids[4]?.at ?? head,
      "A chart needs 1 to 4 tables",
      "content.tables",
    );
  const tables = grids.slice(0, 4).map((g, ti) => table(d, ti, g));
  const { measure = { steps: [] }, videoUrl, fit } = settings ?? {};
  return d.finish({
    name,
    template: head.cells[2],
    content: {
      v: 1,
      unit: head.cells[3],
      roundTo: Number(head.cells[4]),
      tables,
      measure,
      ...(videoUrl !== undefined && { videoUrl }),
      ...(fit !== undefined && { fit }),
    },
  });
}
