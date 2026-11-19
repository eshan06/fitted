// CSV of size charts in Fitted's own layout, which ARCHITECTURE §13 records.
// Export writes every part of a chart, so importing the file brings it back
// unchanged; any other file is read as one plain table. Import is a trust
// boundary, served by one instance (§17): every cell is checked, and every
// step runs in linear time on any input.
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

// The upload as the raw request body, streamed and cut off at the cap, and its
// file name, which names a plain table's chart. A bad chart becomes an
// `unreadable` draft; only a file it can't read throws.
export async function importCsv(
  body: ReadableStream<Uint8Array> | null,
  fileName = "",
): Promise<ChartDraft[]> {
  const text = await readText(body);
  const sep = delimiter(text);
  const semi = sep === ";";
  const rows = records(text, sep);
  const first = rows.next();
  if (first.done) throw new CsvFileError("The file is empty.");
  const { line, cells } = first.value;
  if (cells[0] !== MARK) return [plainChart(first.value, rows, fileName, semi)];
  if (cells[1] !== "1")
    throw new CsvFileError(`Row ${line}: Fitted can't read this CSV version.`);
  // A chart at a time, so only one chart's rows are held.
  const drafts: ChartDraft[] = [];
  let chart: Rec[] | undefined;
  for (const r of rows)
    if (r.cells[0] === "Chart") {
      if (chart) drafts.push(fittedChart(chart, semi));
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
  drafts.push(fittedChart(chart, semi));
  return drafts;
}

// Whichever of , ; and tab splits the first row into the most cells; a tie
// goes to ; or tab, since labels hold commas more often than either.
function delimiter(text: string) {
  const width = (sep: string) => {
    try {
      return records(text, sep).next().value?.cells.length ?? 0;
    } catch {
      return 0; // a quote this delimiter leaves open
    }
  };
  const [c, s, t] = [",", ";", "\t"].map(width);
  return t > 1 && t >= Math.max(c, s) ? "\t" : s > 1 && s >= c ? ";" : ",";
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
  const head = bytes.toString("latin1", 0, 4);
  if (bytes.includes(0) || head === "PK\x03\x04" || head === "%PDF")
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
function* records(text: string, sep: string): Generator<Rec, void, undefined> {
  const ends = (ch: string | undefined) =>
    ch === undefined || ch === sep || ch === "\r" || ch === "\n";
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
    if (text[i++] === sep) continue;
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
  ids = new Set<string>(); // every id the chart uses, typed or generated
  next = new Map<string, number>();
  // `semi`: the file uses ; between cells, so numbers may use a decimal comma.
  constructor(
    readonly head: Rec,
    readonly semi: boolean,
  ) {}
  // An id for a part the file leaves blank, as the editor makes them.
  fresh(prefix: string) {
    let n = this.next.get(prefix) ?? 1;
    while (this.ids.has(`${prefix}${n}`)) n++;
    this.next.set(prefix, n + 1);
    this.ids.add(`${prefix}${n}`);
    return `${prefix}${n}`;
  }
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
  // `check`: the reason to check the units of a chart that is otherwise ready.
  finish(
    input: { name: string; template: unknown; content: object },
    check?: string,
  ): ChartDraft {
    let chart: ChartInput | undefined;
    try {
      const words = Object.fromEntries(this.words);
      chart = validateChart({ ...input, content: { ...input.content, words } });
    } catch (err) {
      if (!(err instanceof ChartValidationError)) throw err;
      for (const [path, text] of Object.entries(err.fieldErrors)) {
        if (this.reported.has(path)) continue;
        // Cells and words are placed by their whole path, the rest by its first
        // six segments at most: walking up a long key dot by dot is quadratic.
        const parts = path.split(".", 6);
        let at = this.at.get(path);
        for (let n = parts.length; !at && n; n--)
          at = this.at.get(parts.slice(0, n).join("."));
        this.fail(at ?? this.head, text);
      }
    }
    if (!chart || this.errors.length)
      return unreadable(input.name, this.errors);
    const { name, template, content } = chart;
    const draft = { name, template, content, products: [] };
    return check
      ? { ...draft, status: "check_units", reason: check }
      : { ...draft, status: "ready" };
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

type Country = Extract<Column, { kind: "country" }>["country"];
type Unit = NonNullable<Extract<Column, { kind: "measure" }>["unit"]>;
// Each part matches one way only, so a hostile cell can't make it backtrack.
const NUM = String.raw`((?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)`;
const WORDS = String.raw`inch(?:es)?|in|cm|centimet(?:er|re)s|lbs?|kgs?`;
const VALUE = new RegExp(
  `^${NUM}(?:\\s*(?:-|–|—|to)\\s*${NUM})?(?:\\s*(${WORDS}|")\\.?)?$`,
  "i",
);
// A unit word's first letter names its unit.
const UNIT = new Map<string, Unit>(
  Object.entries({ i: "in", '"': "in", c: "cm", l: "lb", k: "kg" }),
);
const unitOf = (word: string) => UNIT.get(word[0].toLowerCase());
const NAME = { in: "inches", cm: "centimeters", lb: "pounds", kg: "kilograms" };
// A measure cell: a number or a range, which may name its unit. A dash or
// nothing is no value (undefined); anything else is a bad cell (null).
function measureCell(v: string | undefined, semi: boolean) {
  if (!v || v === "-" || v === "–" || v === "—") return undefined;
  const m = VALUE.exec(semi ? v.replaceAll(",", ".") : v);
  if (!m) return null;
  const cell: Cell = m[2] === undefined ? [+m[1]] : [+m[1], +m[2]];
  return { cell, unit: m[3] === undefined ? undefined : unitOf(m[3]) };
}
// A plain table's labels: a country, or a unit at the end. The unit search is
// unanchored, so it backtracks: only short labels are searched.
const COUNTRY = /^(US|UK|EU|AU)(?: sizes?)?$/i;
const LABEL_UNIT = new RegExp(
  String.raw`[\s,([-]*\b(${WORDS})\.?\s*[)\]]?\s*$`,
  "i",
);
const TYPE = /^(?:(size|text)|(US|UK|EU|AU)|(measure|in|cm|lb|kg)(:fixed)?)$/;
// An id past 8 characters fails validateChart anyway; cut to 9, it can't make
// every key built from it as long (V8 hashes a long string by its length).
const cut = (id = "") => id.slice(0, 9);
const UNREAD = "This row has text in a cell Fitted doesn't read";

// A column with no type, from its label and cells as §13 says. `label` comes
// back without the unit it named: the size guide shows the unit itself.
function infer(
  id: string,
  j: number,
  label: string | undefined,
  vs: ReturnType<typeof measureCell>[],
): { column: Column; label?: string } {
  const country = label && COUNTRY.exec(label.trim())?.[1];
  const u = label && label.length <= 100 ? LABEL_UNIT.exec(label) : null;
  const filled = vs.filter((v) => v !== undefined).length;
  if (j === 0) return { column: { id, kind: "size" }, label };
  if (country) {
    const c = country.toUpperCase() as Country;
    return { column: { id, kind: "country", country: c }, label };
  }
  // Mostly numbers or ranges: more than half the filled cells.
  if (!u && vs.filter(Boolean).length * 2 <= filled)
    return { column: { id, kind: "text" }, label };
  const unit = u ? unitOf(u[1]) : vs.find((v) => v?.unit)?.unit;
  return {
    column: { id, kind: "measure", ...(unit && { unit }), convert: true },
    label: u ? label?.slice(0, u.index) || undefined : label,
  };
}

// One table: its Table row, then the rows that belong to it. `from` is its
// first column of sizes (Fitted's rows start with a kind and an id), and
// `unit` the chart's, which measure cells may repeat.
type Grid = { at: Rec; rows: Rec[]; merges: Rec[]; from: number } & {
  [K in (typeof KEY)[keyof typeof KEY]]?: Rec;
};
function table(d: Draft, ti: number, tid: string, g: Grid, unit?: Unit) {
  const p = `content.tables.${ti}`;
  d.at.set(p, g.at);
  if (g.rows.length < 1 || g.rows.length > 60)
    d.fail(g.rows[60] ?? g.at, "A table needs 1 to 60 size rows", `${p}.rows`);
  const rows = g.rows.slice(0, 60); // the rest are reported above
  rows.forEach((r, ri) => d.at.set(`${p}.rows.${ri}`, r));
  const rids = rows.map((r) => (g.from && cut(r.cells[1])) || d.fresh("r"));
  // A row is as wide as its last filled cell: spreadsheets pad rows.
  const width = (r?: Rec) =>
    r?.cells.reduce((w, c, i) => (c === undefined ? w : i + 1 - g.from), 0) ??
    0;
  const n = Math.max(0, width(g.types), width(g.labels), ...rows.map(width));
  const head = g.types ?? g.at;
  if (n < 1 || n > 20)
    d.fail(head, "A table needs 1 to 20 columns", `${p}.columns`);
  // Their second cell is blank in Fitted's layout.
  if (g.from)
    for (const r of [g.types, g.labels]) if (r?.cells[1]) d.fail(r, UNREAD);
  const columns: Column[] = [];
  const cells = rows.map(() => new Map<string, Cell>());
  for (let j = 0; j < Math.min(n, 20); j++) {
    const cell = (r?: Rec) => r?.cells[j + g.from];
    // Named by its label in reasons, or its letter when that is blank or long.
    const shown = cell(g.labels)?.trim();
    const letter = `column ${String.fromCharCode(65 + g.from + j)}`;
    const col = shown && shown.length <= 40 ? shown : letter;
    const where = { line: head.line, col };
    const vs = rows.map((r) => measureCell(cell(r), d.semi));
    // `<id>:<type>`; a blank id is generated, and a blank type inferred.
    const spec = cell(g.types) ?? "";
    const k = spec.indexOf(":");
    const id = cut(k < 0 ? spec : spec.slice(0, k)) || d.fresh("c");
    const m = k < 0 ? null : TYPE.exec(spec.slice(k + 1));
    if (k >= 0 && spec.length > k + 1 && !m) {
      d.fail(where, "Fitted doesn't know this column's type");
      continue;
    }
    let column: Column;
    let label = cell(g.labels);
    if (m) {
      const [, kind, country, typed, fixed] = m;
      column = kind
        ? { id, kind: kind as "size" | "text" }
        : country
          ? { id, kind: "country", country: country as Country }
          : {
              id,
              kind: "measure",
              ...(typed !== "measure" && { unit: typed as Unit }),
              convert: !fixed,
            };
    } else ({ column, label } = infer(id, j, label, vs));
    d.at.set(`${p}.columns.${columns.push(column) - 1}`, where);
    d.word(`${tid}.${id}`, label, { line: (g.labels ?? head).line, col });
    const want = column.kind === "measure" ? (column.unit ?? unit) : undefined;
    rows.forEach((r, ri) => {
      const w = { line: r.line, col };
      const v = vs[ri];
      if (column.kind !== "measure")
        return d.word(`${tid}.${rids[ri]}.${id}`, cell(r), w);
      if (v === null)
        return d.fail(w, "Use a number like 34.5 or a range like 34–36");
      if (!v) return;
      if (want && v.unit && v.unit !== want)
        return d.fail(
          w,
          `Give this in ${NAME[want]}, like the rest of its column`,
        );
      cells[ri].set(id, v.cell);
      d.at.set(`${p}.rows.${ri}.cells.${id}`, w);
    });
  }
  const out: Table = {
    id: tid,
    columns,
    rows: rows.map((_, ri) => ({
      id: rids[ri],
      cells: Object.fromEntries(cells[ri]),
    })),
  };
  if (g.merges.length)
    out.merges = g.merges.map((m, mi) => {
      d.at.set(`${p}.merges.${mi}`, m);
      const [, row = "", col = "", rows, cols] = m.cells;
      return { row, col, rows: Number(rows), cols: Number(cols) };
    });
  // validateChart allows 20 ids, so a long Wrap row keeps 21.
  const ids = g.wrap?.cells.slice(1).filter((w) => w !== undefined) ?? [];
  if (g.wrap) d.at.set(`${p}.wrap`, g.wrap);
  if (ids.length) out.wrap = ids.slice(0, 21);
  return out;
}

// Rows a table holds once, by the Grid key each fills.
const KEY = { Columns: "types", Labels: "labels", Wrap: "wrap" } as const;
const SETTINGS = ["measure", "videoUrl", "fit"];
// The cells each row kind holds, so text typed past them is reported, not lost.
const FIELDS = new Map(
  Object.entries({ Chart: 5, Settings: 2, Table: 5, Text: 3, Merge: 5 }),
);
const TOO_LARGE = "The chart is too large; split it into smaller charts";
const BROKEN =
  "This chart had errors in Fitted when the file was made, so the file has only its name";

// One chart of Fitted's layout: its Chart row, then the rows that belong to it.
function fittedChart([head, ...rest]: Rec[], semi: boolean): ChartDraft {
  const name = head.cells[1] ?? "";
  const d = new Draft(head, semi);
  const broken = rest.find((r) => r.cells[0] === "Error");
  if (rest.length === MAX_ROWS) d.fail(rest[MAX_ROWS - 1], TOO_LARGE);
  else if (broken) d.fail(broken, BROKEN);
  if (d.errors.length) return unreadable(name, d.errors);
  const grids: Grid[] = [];
  let settings: Record<string, unknown> | undefined;
  for (const r of [head, ...rest])
    if (r.cells.slice(FIELDS.get(r.cells[0] ?? "") ?? Infinity).some(Boolean))
      d.fail(r, UNREAD);
  for (const r of rest) {
    const [kind = "", b, c] = r.cells;
    const t = grids.at(-1);
    if (kind === "Table") {
      grids.push({ at: r, rows: [], merges: [], from: 2 });
      // Tables past the fourth are reported below, not read.
      if (grids.length <= 4)
        ["title", "sub", "note"].forEach((k, i) =>
          d.word(`${cut(b)}.${k}`, r.cells[i + 2], r),
        );
    } else if (kind === "Settings" && !settings) {
      let s: Record<string, unknown> | undefined;
      try {
        // Text that starts with { parses to an object or throws.
        if (b?.startsWith("{")) s = JSON.parse(b);
      } catch {
        // reported below
      }
      const ok = s && Object.keys(s).every((k) => SETTINGS.includes(k));
      if (!ok) d.fail(r, "This Settings row isn't in the form Fitted writes");
      settings = ok ? s : {};
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
  if (grids.length < 1 || grids.length > 4) {
    d.fail(grids[4]?.at ?? head, "A chart needs 1 to 4 tables");
    d.reported.add("content.tables");
  }
  const { measure = { steps: [] }, videoUrl, fit } = settings ?? {};
  // Every id typed in the chart, so a generated one never repeats one.
  for (const g of grids) {
    d.ids.add(cut(g.at.cells[1]));
    for (const r of g.rows) d.ids.add(cut(r.cells[1]));
    for (const t of g.types?.cells.slice(2) ?? [])
      d.ids.add(cut(t?.split(":", 1)[0]));
  }
  const { steps } = Object(measure) as { steps?: unknown };
  const { questions } = Object(fit) as { questions?: unknown };
  for (const v of [steps, questions].flat()) {
    const id: unknown = typeof v === "string" ? v : Object(v).id;
    if (typeof id === "string") d.ids.add(cut(id));
  }
  const [, , , unit, roundTo = ""] = head.cells;
  const length = unit === "in" || unit === "cm" ? unit : undefined;
  const tables = grids
    .slice(0, 4)
    .map((g, ti) => table(d, ti, cut(g.at.cells[1]), g, length));
  return d.finish({
    name,
    template: head.cells[2],
    content: {
      v: 1,
      unit,
      roundTo: Number(semi ? roundTo.replace(",", ".") : roundTo),
      tables,
      measure,
      ...(videoUrl !== undefined && { videoUrl }),
      ...(fit !== undefined && { fit }),
    },
  });
}

const CHECK =
  "The file doesn't say whether the measurements are in inches or centimeters.";

// Any other file is one plain table (§13): a row of labels, then a row per
// size, named after the file.
function plainChart(
  head: Rec,
  rest: Iterable<Rec>,
  fileName: string,
  semi: boolean,
): ChartDraft {
  const d = new Draft(head, semi);
  const rows: Rec[] = [];
  // Rows past the 61st are only read: the 61st is reported as one too many.
  for (const r of rest) if (rows.length <= 60) rows.push(r);
  const grid = { at: head, labels: head, rows, merges: [], from: 0 };
  const t = table(d, 0, d.fresh("t"), grid);
  // Lengths take the unit most of them name; with none named, it's a guess.
  const lengths = t.columns.flatMap((c) =>
    c.kind === "measure" && (c.unit === "in" || c.unit === "cm") ? c.unit : [],
  );
  const cm = lengths.filter((u) => u === "cm").length;
  const guess =
    !lengths.length && t.columns.some((c) => c.kind === "measure" && !c.unit);
  const name = fileName
    .replace(/\.[^.]*$/, "")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim()
    .slice(0, 100)
    .replace(/\p{Cs}$/u, ""); // half of a character cut in two
  return d.finish(
    {
      name: name.trim() || "Imported chart",
      template: "blank",
      content: {
        v: 1,
        unit: cm * 2 > lengths.length ? "cm" : "in",
        roundTo: 0.5,
        tables: [t],
        measure: { steps: [] },
      },
    },
    guess ? CHECK : undefined,
  );
}
