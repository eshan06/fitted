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
export const TEMPLATES: Record<Template, string> = {
  blank: "Blank",
  tops: "Tops",
  bottoms: "Bottoms",
  dresses: "Dresses",
  bras_swimwear: "Bras and swimwear",
  shoes: "Shoes",
  kids: "Kids",
  headwear: "Headwear",
  rings: "Rings",
  bracelets: "Bracelets",
  necklaces: "Necklaces",
};
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

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const hasIds = (v: unknown): v is { id: string }[] =>
  Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === "string");
/**
 * A stored chart that fails the checks, as a draft the editor can draw, or
 * null when its shape is too broken for the table. Bad values stay as typed
 * text, so the editor's own check marks them.
 */
export function storedDraft(raw: unknown, status: ChartStatus): Draft | null {
  if (!isObj(raw) || !isObj(raw.content)) return null;
  const c = raw.content;
  const drawable =
    Array.isArray(c.tables) &&
    c.tables.length > 0 &&
    c.tables.every(
      (t) =>
        isObj(t) &&
        typeof t.id === "string" &&
        hasIds(t.columns) &&
        t.columns.length > 0 &&
        hasIds(t.rows) &&
        t.rows.every((r) => isObj((r as { cells?: unknown }).cells)),
    ) &&
    isObj(c.measure) &&
    Array.isArray(c.measure.steps) &&
    isObj(c.words) &&
    Object.values(c.words).every((w) => typeof w === "string") &&
    (c.fit === undefined || (isObj(c.fit) && hasIds(c.fit.questions)));
  if (!drawable || typeof raw.template !== "string") return null;
  if (!Object.hasOwn(TEMPLATES, raw.template)) return null;
  const content = c as Content;
  const cells: Record<string, string> = {};
  for (const row of content.tables[0].rows)
    for (const [col, cell] of Object.entries(row.cells as object))
      cells[`${row.id}.${col}`] = Array.isArray(cell)
        ? cell.join("–")
        : String(cell);
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    template: raw.template as Template,
    status,
    content,
    cells,
    ...(typeof raw.measureImage === "string" && {
      measureImage: raw.measureImage,
    }),
  };
}

export type Selected =
  { row: string; col?: undefined } | { col: string; row?: undefined };
const sizeOf = (d: Draft, ri: number) => {
  const t = table(d);
  const w = d.content.words[`${t.id}.${t.rows[ri].id}.${t.columns[0].id}`];
  return w || `Size ${ri + 1}`;
};
export const colName = (d: Draft, col: string) =>
  d.content.words[`${table(d).id}.${col}`] || "Measurement";
const valueAt = (d: Draft, row: string, col: string) => {
  const t = table(d);
  const measure = t.columns.find((c) => c.id === col)?.kind === "measure";
  const v = measure
    ? d.cells[`${row}.${col}`]
    : d.content.words[`${t.id}.${row}.${col}`];
  return v?.trim() ?? "";
};
const and = (l: string[]) =>
  l.length > 1 ? `${l.slice(0, -1).join(", ")} and ${l.at(-1)}` : l[0];

/** The Remove dialog's words; `text` is null when the size or column holds no values. */
export function removal(d: Draft, sel: Selected) {
  const t = table(d);
  if (sel.row !== undefined) {
    const size = sizeOf(
      d,
      t.rows.findIndex((r) => r.id === sel.row),
    );
    const vals = t.columns
      .slice(1)
      .filter((c) => valueAt(d, sel.row, c.id))
      .map((c) => `${colName(d, c.id)} ${valueAt(d, sel.row, c.id)}`);
    return {
      heading: `Remove size ${size}?`,
      label: "Remove size",
      text: vals.length
        ? `Saving removes ${size}'s values: ${and(vals)}.`
        : null,
    };
  }
  const name = colName(d, sel.col);
  const vals = t.rows.flatMap((r, ri) => {
    const v = valueAt(d, r.id, sel.col);
    return v ? [`${v} (${sizeOf(d, ri)})`] : [];
  });
  const n = vals.length;
  const all = n === t.rows.length && n > 1 ? "all " : "";
  return {
    heading: `Remove the ${name} measurement?`,
    label: "Remove measurement",
    text: n
      ? `Saving removes ${name} from ${all}${n} ${n === 1 ? "size" : "sizes"}, ${n > 1 ? `${vals[0]} to ${vals[n - 1]}` : vals[0]}. Shoppers won't see a ${name} column.`
      : null,
  };
}

const strip = <V>(o: Record<string, V>, drop: (k: string) => boolean) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !drop(k)));
/**
 * Takes a size or a column out of the first table with its values and words,
 * and out of every merge, wrap and fit finder setting that names it, so the
 * rest still passes the checks.
 */
export function remove(d: Draft, sel: Selected): Draft {
  const t = table(d);
  const at = (list: { id: string }[], id?: string) =>
    list.findIndex((x) => x.id === id);
  const inSpan = (from: number, span: number, i: number) =>
    i >= 0 && i >= from && i < from + span;
  const [ri, ci] = [at(t.rows, sel.row), at(t.columns, sel.col)];
  let fit = d.content.fit;
  let lost: string[] = [];
  if (fit?.table === t.id) {
    lost = fit.questions
      .filter((q) => q.kind === "measure" && q.col === sel.col)
      .map((q) => `fit.${q.id}`);
    // ponytail: a choice left with no sizes still fails the checks, and the save names it.
    const questions = fit.questions
      .filter((q) => !lost.includes(`fit.${q.id}`))
      .map((q) =>
        q.kind !== "choice"
          ? q
          : {
              ...q,
              options: q.options.map((o) => ({
                ...o,
                rows: o.rows.filter((r) => r !== sel.row),
              })),
            },
      );
    fit = { ...fit, questions, ease: strip(fit.ease, (k) => k === sel.col) };
  }
  const next = withTable(d, {
    rows: t.rows
      .filter((r) => r.id !== sel.row)
      .map((r) => ({ ...r, cells: strip(r.cells, (k) => k === sel.col) })),
    columns: t.columns.filter((c) => c.id !== sel.col),
    ...(t.merges && {
      merges: t.merges.filter(
        (m) =>
          !inSpan(at(t.rows, m.row), m.rows, ri) &&
          !inSpan(at(t.columns, m.col), m.cols, ci),
      ),
    }),
    ...(t.wrap && { wrap: t.wrap.filter((w) => w !== sel.col) }),
  });
  const gone = (k: string) => {
    const [a, b, c] = k.split(".");
    if (lost.includes(k)) return true;
    if (a !== t.id) return false;
    return sel.row !== undefined
      ? b === sel.row
      : b === sel.col || c === sel.col;
  };
  return {
    ...next,
    content: {
      ...next.content,
      words: strip(d.content.words, gone),
      ...(fit && { fit }),
    },
    cells: strip(d.cells, (k) => {
      const [r, c] = k.split(".");
      return r === sel.row || c === sel.col;
    }),
  };
}
