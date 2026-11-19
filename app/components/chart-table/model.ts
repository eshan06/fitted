// The editor's working copy of a chart (ARCHITECTURE §5). It edits the first
// table; other tables, steps and the fit finder ride along untouched. Numbers
// stay as typed text until Save, so a half-typed range never gets lost.
import type {
  ChartInput,
  ChartStatus,
  Content,
  FieldErrors,
  Template,
} from "../../models/chart.server";

type Cell = [number] | [number, number];
export type Draft = {
  name: string;
  template: Template;
  status: ChartStatus;
  content: Content;
  /** `<row>.<col>` to the text typed in the first table's measure cells */
  cells: Record<string, string>;
  measureImage?: string;
};

export const blankDraft = (): Draft => ({
  name: "",
  template: "blank",
  status: "DRAFT",
  content: {
    v: 1,
    unit: "in",
    roundTo: 0.5,
    tables: [{ id: "t1", columns: [{ id: "size", kind: "size" }], rows: [] }],
    measure: { steps: [] },
    words: { "t1.size": "Size" },
  },
  cells: {},
});

export const formatCell = (c: Cell) => c.join("–");

// "31", "31.5", "31,5" or a range "31–32" / "31 - 32". Empty is no value.
const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const CELL = new RegExp(String.raw`^${NUM}(?:\s*[-–—]\s*${NUM})?$`);
export function parseCell(text: string): Cell | null | "invalid" {
  const t = text.trim();
  if (!t) return null;
  const m = CELL.exec(t);
  if (!m) return "invalid";
  const nums = [m[1], m[2]]
    .filter(Boolean)
    .map((n) => Number(n.replace(",", ".")));
  return nums.length === 2 && nums[0] === nums[1] ? [nums[0]] : (nums as Cell);
}

// What's wrong with a typed cell: `short` for the banner ("M, Bust is 0"),
// `long` for the list under the table (the Editor board's words).
export function cellProblem(text: string) {
  const c = parseCell(text);
  if (c === null) return null;
  const say = (short: string, long: string) => ({ short, long });
  if (c === "invalid") {
    const first = new RegExp(String.raw`^${NUM}\s*[-–—]$`).exec(text.trim());
    if (!first)
      return say("isn't a number", "Type a number, or a range like 31–32.");
    const n = Number(first[1].replace(",", "."));
    return say(
      "is missing the second number",
      `Add the second number, like ${n}–${n + 1}, or delete the dash.`,
    );
  }
  if (c.some((n) => n <= 0))
    return say("is 0", "Use a number above 0, or clear the cell.");
  if (c.some((n) => n >= 10000))
    return say(
      "is 10,000 or more",
      "Use a number below 10,000, or clear the cell.",
    );
  if (c.length === 2 && c[0] > c[1])
    return say(
      "runs from high to low",
      `Put the smaller number first, like ${c[1]}–${c[0]}.`,
    );
  return null;
}

export function toDraft(chart: ChartInput, status: ChartStatus): Draft {
  const t = chart.content.tables[0];
  const cells: Record<string, string> = {};
  for (const row of t.rows)
    for (const [col, cell] of Object.entries(row.cells))
      cells[`${row.id}.${col}`] = formatCell(cell);
  return {
    name: chart.name,
    template: chart.template,
    status,
    content: chart.content,
    cells,
    ...(chart.measureImage && { measureImage: chart.measureImage }),
  };
}

const table = (d: Draft) => d.content.tables[0];
const withTable = (d: Draft, patch: Partial<Content["tables"][0]>): Draft => ({
  ...d,
  content: {
    ...d.content,
    tables: [{ ...table(d), ...patch }, ...d.content.tables.slice(1)],
  },
});

// Ids are unique across the chart and never "title", "sub" or "note".
function freshId(c: Content, prefix: string) {
  const used = new Set<string>(c.measure.steps);
  for (const t of c.tables) {
    used.add(t.id);
    t.columns.forEach((col) => used.add(col.id));
    t.rows.forEach((r) => used.add(r.id));
  }
  c.fit?.questions.forEach((q) => used.add(q.id));
  for (let n = 1; ; n++) if (!used.has(prefix + n)) return prefix + n;
}

export const MAX_ROWS = 60;
export const MAX_COLUMNS = 20;
export const addSize = (d: Draft) =>
  table(d).rows.length >= MAX_ROWS
    ? d
    : withTable(d, {
        rows: [...table(d).rows, { id: freshId(d.content, "r"), cells: {} }],
      });
export const addMeasurement = (d: Draft) =>
  table(d).columns.length >= MAX_COLUMNS
    ? d
    : withTable(d, {
        columns: [
          ...table(d).columns,
          { id: freshId(d.content, "c"), kind: "measure", convert: true },
        ],
      });

export const setWord = (d: Draft, key: string, value: string): Draft => ({
  ...d,
  content: { ...d.content, words: { ...d.content.words, [key]: value } },
});
export const setCell = (d: Draft, row: string, col: string, text: string) => ({
  ...d,
  cells: { ...d.cells, [`${row}.${col}`]: text },
});
export const setUnit = (d: Draft, unit: Content["unit"]): Draft => ({
  ...d,
  content: { ...d.content, unit },
});

/** The chart to save, or the problems to fix first, keyed like validateChart's paths. */
export function toInput(
  d: Draft,
): { input: ChartInput } | { fieldErrors: FieldErrors } {
  const errs: FieldErrors = {};
  const t = table(d);
  const measures = t.columns.filter((c) => c.kind === "measure");
  if (!d.name.trim()) errs.name = "Give the chart a name";
  if (!t.rows.length) errs["content.tables.0.rows"] = "Add at least one size";
  for (const col of measures)
    if (!d.content.words[`${t.id}.${col.id}`]?.trim())
      errs[`content.words.${t.id}.${col.id}`] = "Name this measurement";
  // validateChart makes the first column, and only it, the size column.
  const rows = t.rows.map((row, ri) => {
    const name = `${t.id}.${row.id}.${t.columns[0].id}`;
    if (!d.content.words[name]?.trim())
      errs[`content.words.${name}`] = "Name this size";
    const cells: Record<string, Cell> = {};
    for (const col of measures) {
      const text = d.cells[`${row.id}.${col.id}`] ?? "";
      const problem = cellProblem(text);
      const cell = parseCell(text);
      if (problem)
        errs[`content.tables.0.rows.${ri}.cells.${col.id}`] = problem.long;
      else if (cell && cell !== "invalid") cells[col.id] = cell;
    }
    return { id: row.id, cells };
  });
  if (Object.keys(errs).length) return { fieldErrors: errs };
  // An emptied word is left out rather than saved blank.
  const words = Object.fromEntries(
    Object.entries(d.content.words).filter(([, w]) => w.trim()),
  );
  return {
    input: {
      name: d.name.trim(),
      template: d.template,
      content: {
        ...withTable(d, { rows }).content,
        words,
      },
      ...(d.measureImage && { measureImage: d.measureImage }),
    },
  };
}

/** A problem placed in the editor: the field to focus, and how to name it. */
export type Problem = {
  id?: string;
  where: string;
  short?: string;
  long: string;
};
export function problems(d: Draft, errors: FieldErrors): Problem[] {
  const t = table(d);
  const words = d.content.words;
  const sizeName = (ri: number) =>
    words[`${t.id}.${t.rows[ri].id}.${t.columns[0].id}`] || `Size ${ri + 1}`;
  const colName = (col: string) => words[`${t.id}.${col}`] || "Measurement";
  const wordAt = `content.words.${t.id}.`;
  return Object.entries(errors).map(([key, long]) => {
    const cell = /^content\.tables\.0\.rows\.(\d+)\.cells\.(.+)$/.exec(key);
    const ri = cell ? Number(cell[1]) : -1;
    if (cell && t.rows[ri]) {
      const text = d.cells[`${t.rows[ri].id}.${cell[2]}`] ?? "";
      return {
        id: `cell-${t.rows[ri].id}-${cell[2]}`,
        where: `${sizeName(ri)}, ${colName(cell[2])}`,
        short: cellProblem(text)?.short,
        long,
      };
    }
    if (key === "name") return { id: "name", where: "Chart name", long };
    const [a, b, extra] = key.startsWith(wordAt)
      ? key.slice(wordAt.length).split(".")
      : [];
    const ci = t.columns.findIndex((c) => c.id === (b ?? a));
    const wi = t.rows.findIndex((r) => r.id === a);
    if (!extra && b && wi >= 0 && ci >= 0)
      return {
        id: `cell-${a}-${b}`,
        where: ci ? `${sizeName(wi)}, ${colName(b)}` : `Size ${wi + 1}`,
        long,
      };
    if (a && !b && ci >= 0)
      return { id: `cell-h-${a}`, where: `Column ${ci + 1} name`, long };
    return { where: "", long };
  });
}
