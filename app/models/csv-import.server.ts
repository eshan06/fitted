// CSV import and export, ARCHITECTURE §13, which records the layout. Import
// is a trust boundary: the upload is capped while it streams, must be UTF-8
// text, and every cell is checked, ending with validateChart. Export writes
// every chart in Fitted's own layout, so a round trip loses nothing.
import {
  type ChartInput,
  ChartValidationError,
  type Column,
  type Content,
  type Table,
  type Template,
  validateChart,
} from "./chart.server";

export const CSV_MAX_BYTES = 1024 * 1024;

// What every import source hands the import flow (§13). A CSV carries no
// product assignments.
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

const MARK = "Fitted size charts";
// Spreadsheets run a cell starting with one of these as a formula. Export puts
// an apostrophe in front, even when apostrophes already lead, and import takes
// one off, so the text comes back exactly.
const FORMULA = /^'*[=+\-@\t\r]/;
const csvCell = (v: string) => {
  const s = FORMULA.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const typeOf = (c: Column) =>
  c.kind === "country"
    ? c.country
    : c.kind === "measure"
      ? `${c.unit ?? "measure"}${c.convert ? "" : ":fixed"}`
      : c.kind;

export function exportCsv(charts: { name: string; chart?: ChartInput }[]) {
  const out: string[][] = [[MARK, "1"]];
  for (const { name, chart } of charts) {
    if (!chart) {
      // Never dropped silently (§5): the file names it, and importing says why it's empty.
      out.push(["Chart", name], ["Error", "This chart has errors in Fitted"]);
      continue;
    }
    const c = chart.content;
    const used = new Set<string>();
    const word = (key: string) => (used.add(key), c.words[key] ?? "");
    out.push(["Chart", chart.name, chart.template, c.unit, `${c.roundTo}`]);
    const { measure, videoUrl, fit } = c;
    out.push(["Settings", JSON.stringify({ measure, videoUrl, fit })]);
    for (const t of c.tables) {
      const words = ["title", "sub", "note"].map((k) => word(`${t.id}.${k}`));
      out.push(["Table", t.id, ...words]);
      out.push([
        "Columns",
        "",
        ...t.columns.map((k) => `${k.id}:${typeOf(k)}`),
      ]);
      out.push([
        "Labels",
        "",
        ...t.columns.map((k) => word(`${t.id}.${k.id}`)),
      ]);
      for (const r of t.rows)
        out.push([
          "Row",
          r.id,
          ...t.columns.map((k) =>
            k.kind === "measure"
              ? (r.cells[k.id]?.join("–") ?? "")
              : word(`${t.id}.${r.id}.${k.id}`),
          ),
        ]);
      for (const m of t.merges ?? [])
        out.push(["Merge", m.row, m.col, `${m.rows}`, `${m.cols}`]);
      if (t.wrap?.length) out.push(["Wrap", ...t.wrap]);
    }
    for (const [key, text] of Object.entries(c.words))
      if (!used.has(key)) out.push(["Text", key, text]);
  }
  // The BOM makes Excel read the file as UTF-8.
  return `\uFEFF${out.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

// The upload, sent as the raw request body: read as a stream and cut off at
// the cap, never buffered whole first.
export async function importCsv(
  body: ReadableStream<Uint8Array> | null,
  fileName = "",
): Promise<ChartDraft[]> {
  const { recs, semi } = records(await readText(body));
  if (!recs.length) throw new CsvFileError("The file is empty.");
  if (recs[0].cells[0] !== MARK) return [plainChart(recs, fileName, semi)];
  if (recs[0].cells[1] !== "1")
    throw new CsvFileError("Row 1: Fitted can't read this version of its CSV.");
  const charts: Rec[][] = [];
  for (const r of recs.slice(1))
    if (r.cells[0] === "Chart") charts.push([r]);
    else if (charts.length) charts[charts.length - 1].push(r);
    else throw new CsvFileError(`Row ${r.line}: put a Chart row above it.`);
  if (!charts.length) throw new CsvFileError("The file has no charts.");
  return charts.map((g) => fittedChart(g, semi));
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
        "The file is over 1 MB. Split it into smaller files and upload each one.",
      );
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  // No magic number marks a CSV, so refuse what is plainly something else:
  // binary, a zip (an Excel workbook) or a PDF.
  if (bytes.includes(0) || /^(PK|%PDF)/.test(bytes.toString("latin1", 0, 4)))
    throw new CsvFileError(SAVE_AS);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes); // drops a BOM
  } catch {
    throw new CsvFileError(SAVE_AS);
  }
}

// Rows of trimmed cells, numbered as a spreadsheet shows them, blank ones left
// out. The delimiter is whichever of , ; or tab the first row uses most
// outside quotes.
type Rec = { line: number; cells: string[] };
function records(text: string) {
  const first = text.slice(0, text.search(/[\r\n]|$/)).replace(/"[^"]*"/g, "");
  const d = [",", ";", "\t"].reduce((a, b) =>
    first.split(b).length > first.split(a).length ? b : a,
  );
  const recs: Rec[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  const end = () => {
    const v = cell.trim();
    cells.push(/^'+[=+\-@\t\r]/.test(v) ? v.slice(1) : v);
    cell = "";
  };
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i]; // undefined past the end
    if (quoted) {
      if (ch === undefined)
        throw new CsvFileError(`Row ${line}: a quote (") is never closed.`);
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') cell += text[i++];
      else quoted = false;
    } else if (ch === '"' && !cell.trim()) {
      quoted = true;
      cell = "";
    } else if (ch === d) end();
    else if (ch === "\r" || ch === "\n" || ch === undefined) {
      end();
      if (cells.some(Boolean)) recs.push({ line, cells });
      cells = [];
      line++;
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else cell += ch;
  }
  return { recs, semi: d === ";" };
}

type Where = { line: number; col?: string };
type Cell = [number] | [number, number];

// One chart's parse: its words, its problems by row, and the row each field
// path came from, so validateChart's errors point at rows of the file.
class Draft {
  words = new Map<string, string>();
  at = new Map<string, Where>();
  errors: { line: number; col?: string; text: string }[] = [];
  reported = new Set<string>(); // paths already reported in CSV terms
  ids = new Set<string>();
  next = new Map<string, number>();
  fail({ line, col }: Where, text: string) {
    this.errors.push({ line, col, text });
  }
  word(key: string, text: string, w: Where) {
    if (!text) return;
    if (this.words.has(key)) return this.fail(w, "This text is given twice");
    this.words.set(key, text);
    this.at.set(`content.words.${key}`, w);
  }
  fresh(prefix: string) {
    let n = this.next.get(prefix) ?? 1;
    while (this.ids.has(prefix + n)) n++;
    this.next.set(prefix, n + 1);
    this.ids.add(prefix + n);
    return prefix + n;
  }
  finish(
    head: Where,
    input: { name: string; template: unknown; content: object },
    unitsGuessed = false,
  ): ChartDraft {
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
        this.fail(this.at.get(p) ?? head, text);
      }
    }
    const name = input.name.trim() || "Untitled chart";
    if (!chart || this.errors.length) {
      const errs = this.errors
        .sort((a, b) => a.line - b.line)
        .map((e) => `Row ${e.line}${e.col ? `, ${e.col}` : ""}: ${e.text}`);
      const more = errs.length > 5 ? `; and ${errs.length - 5} more` : "";
      const reason = `${errs.slice(0, 5).join("; ")}${more}.`;
      return { name, products: [], status: "unreadable", reason };
    }
    const { template, content } = chart;
    const draft = { name: chart.name, template, content, products: [] };
    return unitsGuessed
      ? {
          ...draft,
          status: "check_units",
          reason:
            "The file doesn't say whether the measurements are in inches or centimeters.",
        }
      : { ...draft, status: "ready" };
  }
}

type Country = Extract<Column, { kind: "country" }>["country"];
type Unit = NonNullable<Extract<Column, { kind: "measure" }>["unit"]>;
const SPEC =
  /^([^:]*):(?:(size|text)|(US|UK|EU|AU)|(measure|in|cm|lb|kg)(:fixed)?)$/;
const UNIT =
  /\s*(?:[([]\s*(in|inch|inches|cm|lbs?|kg)\.?\s*[)\]]|[\s,]+(inches|cm|lbs|kg))$/i;
const UNITS: Record<string, Unit> = {
  in: "in",
  inch: "in",
  inches: "in",
  cm: "cm",
  lb: "lb",
  lbs: "lb",
  kg: "kg",
};
const NUM = String.raw`(\d*\.?\d+(?:e[+-]?\d+)?)`;
const VALUE = new RegExp(`^${NUM}(?:\\s*(?:-|–|—|to)\\s*${NUM})?$`, "i");
const blank = (v: string) => /^[-–—]?$/.test(v);
const decimal = (v: string, semi: boolean) =>
  semi ? v.replaceAll(",", ".") : v;
function value(v: string, semi: boolean): Cell | undefined {
  const m = VALUE.exec(decimal(v, semi));
  if (m) return m[2] === undefined ? [+m[1]] : [+m[1], +m[2]];
}

// One table from a grid of rows: `types` names each column (`<id>:<type>`);
// a column without one is inferred from its label and cells, as in a plain
// spreadsheet. `from` is the first grid column (Fitted's rows lead with two).
type Grid = { at: Rec; types?: Rec; labels?: Rec; rows: Rec[]; from: number };
function table(d: Draft, ti: number, tid: string, g: Grid, semi: boolean) {
  const p = `content.tables.${ti}`;
  d.at.set(p, g.at);
  if (g.rows.length < 1 || g.rows.length > 60) {
    d.fail(g.rows[60] ?? g.at, "A table needs 1 to 60 size rows");
    d.reported.add(`${p}.rows`);
  }
  const body = g.rows.slice(0, 60); // the rest are reported above
  const recs = [g.types, g.labels, ...body];
  const cell = (r: Rec | undefined, j: number) => r?.cells[g.from + j] ?? "";
  let n = recs.reduce(
    (n, r) => Math.max(n, (r?.cells.length ?? 0) - g.from),
    0,
  );
  while (n > 0 && recs.every((r) => !cell(r, n - 1))) n--; // trailing empty columns
  const head = g.types ?? g.labels ?? g.at;
  if (n < 1 || n > 20) {
    d.fail(head, "A table needs 1 to 20 columns");
    d.reported.add(`${p}.columns`);
  }
  const rows = body.map((r, ri) => {
    d.at.set(`${p}.rows.${ri}`, r);
    const rid = (g.from && r.cells[1]) || d.fresh("r");
    return { id: rid, cells: new Map<string, Cell>() };
  });
  const columns: Column[] = [];
  for (let j = 0; j < Math.min(n, 20); j++) {
    const letter = String.fromCharCode(65 + g.from + j);
    const type = cell(g.types, j);
    const values = body.map((r) => cell(r, j));
    let label = cell(g.labels, j);
    let col: Column;
    const m = SPEC.exec(type);
    if (m) {
      const id = m[1];
      if (m[2]) col = { id, kind: m[2] as "size" | "text" };
      else if (m[3]) col = { id, kind: "country", country: m[3] as Country };
      else {
        const unit = m[4] === "measure" ? {} : { unit: m[4] as Unit };
        col = { id, kind: "measure", ...unit, convert: !m[5] };
      }
    } else {
      if (type)
        d.fail(
          { line: head.line, col: `column ${letter}` },
          `Fitted doesn't know the column type “${type.slice(0, 40)}”`,
        );
      const id = d.fresh("c");
      const country = /^(US|UK|EU|AU)(?: sizes?)?$/i.exec(label)?.[1];
      const u = UNIT.exec(label);
      const unit = u ? UNITS[(u[1] ?? u[2]).toLowerCase()] : undefined;
      const filled = values.filter((v) => !blank(v));
      const numbers = filled.filter((v) => value(v, semi)).length;
      if (j === 0) col = { id, kind: "size" };
      else if (country)
        col = {
          id,
          kind: "country",
          country: country.toUpperCase() as Country,
        };
      else if (unit || numbers * 2 > filled.length) {
        col = { id, kind: "measure", ...(unit && { unit }), convert: true };
        if (u) label = label.slice(0, u.index);
      } else col = { id, kind: "text" };
    }
    const name = label || `column ${letter}`;
    for (const [ri, r] of body.entries()) {
      const w = { line: r.line, col: name };
      if (col.kind !== "measure")
        d.word(`${tid}.${rows[ri].id}.${col.id}`, values[ri], w);
      else if (!blank(values[ri])) {
        const v = value(values[ri], semi);
        if (!v) d.fail(w, "Use a number like 34.5 or a range like 34–36");
        else {
          rows[ri].cells.set(col.id, v);
          d.at.set(`${p}.rows.${ri}.cells.${col.id}`, w);
        }
      }
    }
    d.word(`${tid}.${col.id}`, label, {
      line: (g.labels ?? head).line,
      col: name,
    });
    d.at.set(`${p}.columns.${j}`, { line: head.line, col: name });
    columns.push(col);
  }
  const out: Table = {
    id: tid,
    columns,
    rows: rows.map((r) => ({ id: r.id, cells: Object.fromEntries(r.cells) })),
  };
  return out;
}

// Fitted's own layout: a Chart row, then the rows that belong to it.
const KEY = { Columns: "types", Labels: "labels", Wrap: "wrap" } as const;
function fittedChart(g: Rec[], semi: boolean): ChartDraft {
  const [head, ...rest] = g;
  const broken = rest.find((r) => r.cells[0] === "Error");
  if (broken)
    return {
      name: head.cells[1] || "Untitled chart",
      products: [],
      status: "unreadable",
      reason: `Row ${broken.line}: This chart had errors in Fitted when the file was made, so the file has only its name.`,
    };
  const d = new Draft();
  // Ids typed in the file come first, so a generated id never repeats one.
  for (const { cells } of rest)
    if (cells[0] === "Columns")
      cells.slice(2).forEach((t) => d.ids.add(t.split(":")[0]));
    else if (cells[0] === "Table" || cells[0] === "Row")
      d.ids.add(cells[1] ?? "");
  const grids: (Grid & { id: string; merges: Rec[]; wrap?: Rec })[] = [];
  let settings:
    { measure?: unknown; videoUrl?: unknown; fit?: unknown } | undefined;
  for (const r of rest) {
    const [kind, b = "", c = ""] = r.cells;
    const t = grids[grids.length - 1];
    if (kind === "Table") {
      const id = b || d.fresh("t");
      grids.push({ id, at: r, rows: [], from: 2, merges: [] });
      // Tables past the fourth are reported below, not read.
      if (grids.length <= 4)
        ["title", "sub", "note"].forEach((k, i) =>
          d.word(`${id}.${k}`, r.cells[i + 2] ?? "", r),
        );
    } else if (kind === "Settings" && !settings) {
      let s: unknown;
      try {
        s = JSON.parse(b);
      } catch {
        // reported below
      }
      const ok = typeof s === "object" && s !== null && !Array.isArray(s);
      const { measure, videoUrl, fit, ...extra } = ok
        ? (s as Record<string, unknown>)
        : {};
      if (!ok || Object.keys(extra).length)
        d.fail(r, "This Settings row isn't in the form Fitted writes");
      settings = { measure, videoUrl, fit };
      ["measure", "videoUrl", "fit"].forEach((k) =>
        d.at.set(`content.${k}`, r),
      );
    } else if (kind === "Text") d.word(b, c, r);
    else if (t && kind === "Row") t.rows.push(r);
    else if (t && kind === "Merge") t.merges.push(r);
    else if (t && Object.hasOwn(KEY, kind) && !t[KEY[kind as keyof typeof KEY]])
      t[KEY[kind as keyof typeof KEY]] = r;
    else
      d.fail(
        r,
        !t && (Object.hasOwn(KEY, kind) || kind === "Row" || kind === "Merge")
          ? "Put a Table row above this row"
          : `Fitted doesn't expect a “${kind.slice(0, 40)}” row here`,
      );
  }
  if (grids.length < 1 || grids.length > 4) {
    d.fail(grids[4]?.at ?? head, "A chart needs 1 to 4 tables");
    d.reported.add("content.tables");
  }
  const number = (v = "") => Number(decimal(v, semi));
  const tables = grids.slice(0, 4).map((t, ti) => {
    const out = table(d, ti, t.id, t, semi);
    t.merges.forEach((m, mi) =>
      d.at.set(`content.tables.${ti}.merges.${mi}`, m),
    );
    if (t.merges.length)
      out.merges = t.merges.map(
        ({ cells: [, row = "", col = "", rows, cols] }) => ({
          row,
          col,
          rows: number(rows),
          cols: number(cols),
        }),
      );
    const wrap = t.wrap?.cells.slice(1).filter(Boolean) ?? [];
    wrap.forEach((_, wi) =>
      d.at.set(`content.tables.${ti}.wrap.${wi}`, t.wrap!),
    );
    if (wrap.length) out.wrap = wrap;
    return out;
  });
  const { measure = { steps: [] }, videoUrl, fit } = settings ?? {};
  const content = {
    v: 1,
    unit: head.cells[3],
    roundTo: number(head.cells[4]),
    tables,
    measure,
    ...(videoUrl !== undefined && { videoUrl }),
    ...(fit !== undefined && { fit }),
  };
  return d.finish(head, {
    name: head.cells[1] ?? "",
    template: head.cells[2],
    content,
  });
}

// Any other file is one spreadsheet table: labels, then a row per size.
function plainChart(recs: Rec[], fileName: string, semi: boolean): ChartDraft {
  const d = new Draft();
  const [header, ...rows] = recs;
  const grid = { at: header, labels: header, rows, from: 0 };
  const t = table(d, 0, d.fresh("t"), grid, semi);
  // Lengths go in the unit most columns name; columns in it inherit it.
  const lengths = t.columns.flatMap((c) =>
    c.kind === "measure" && (c.unit === "in" || c.unit === "cm")
      ? [c.unit]
      : [],
  );
  const unit =
    lengths.filter((u) => u === "cm").length * 2 > lengths.length ? "cm" : "in";
  for (const c of t.columns)
    if (c.kind === "measure" && c.unit === unit) delete c.unit;
  const guessed =
    !lengths.length && t.columns.some((c) => c.kind === "measure" && !c.unit);
  const name = fileName
    .replace(/\.[^.]*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  const content = {
    v: 1,
    unit,
    roundTo: 0.5,
    tables: [t],
    measure: { steps: [] },
  };
  return d.finish(
    header,
    { name: name || "Imported chart", template: "blank", content },
    guessed,
  );
}
