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
  const rows = t.rows.map((row, ri) => {
    const name = `${t.id}.${row.id}.${t.columns[0].id}`;
    if (!d.content.words[name]?.trim())
      errs[`content.words.${name}`] = "Name this size";
    const cells: Record<string, Cell> = {};
    for (const col of measures) {
      const cell = parseCell(d.cells[`${row.id}.${col.id}`] ?? "");
      if (cell === "invalid" || (cell && cell[0] > cell[cell.length - 1]))
        errs[`content.tables.0.rows.${ri}.cells.${col.id}`] =
          "Type a number, or a range like 31–32";
      else if (cell) cells[col.id] = cell;
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
