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
 * A stored chart that fails the checks, as a draft the editor can draw and
 * fix, or null when its shape is too broken for the table or a finding is in
 * something the editor can't change. Bad values stay as typed text, so the
 * editor's own check marks them.
 */
export function storedDraft(
  raw: unknown,
  status: ChartStatus,
  errors: FieldErrors,
): Draft | null {
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
  // A value the save drops must be one dropped() can name: a number in a
  // column the table has.
  const first = content.tables[0];
  const kept = first.rows.every((r) =>
    Object.entries(r.cells as object).every(([col, cell]) => {
      const kind = first.columns.find((x) => x.id === col)?.kind;
      return (
        kind === "measure" ||
        (kind !== undefined &&
          Array.isArray(cell) &&
          (cell.length === 1 || cell.length === 2) &&
          cell.every((n) => typeof n === "number"))
      );
    }),
  );
  if (!kept) return null;
  const cells: Record<string, string> = {};
  for (const row of content.tables[0].rows)
    for (const [col, cell] of Object.entries(row.cells as object))
      cells[`${row.id}.${col}`] = Array.isArray(cell)
        ? cell.join("–")
        : String(cell);
  const d: Draft = {
    name: typeof raw.name === "string" ? raw.name : "",
    template: raw.template as Template,
    status,
    content,
    cells,
    ...(typeof raw.measureImage === "string" && {
      measureImage: raw.measureImage,
    }),
  };
  // Every finding must land on a field the editor shows: the units and the
  // note, or one problems() can point at.
  const note = `content.words.${content.tables[0].id}.note`;
  const rest = Object.fromEntries(
    Object.entries(errors).filter(([k]) => k !== "content.unit" && k !== note),
  );
  return problems(d, rest).every((p) => p.id) ? d : null;
}

export type Selected =
  { row: string; col?: undefined } | { col: string; row?: undefined };
export const sizeOf = (d: Draft, ri: number) => {
  const t = table(d);
  const w = d.content.words[`${t.id}.${t.rows[ri].id}.${t.columns[0].id}`];
  return w?.trim() || `Size ${ri + 1}`;
};
export const colName = (d: Draft, col: string) =>
  d.content.words[`${table(d).id}.${col}`] || "Measurement";
const valueAt = (d: Draft, row: string, col: string) => {
  const t = table(d);
  const measure = t.columns.find((c) => c.id === col)?.kind === "measure";
  const v = measure
    ? d.cells[`${row}.${col}`]
    : d.content.words[`${t.id}.${row}.${col}`]?.trim() ||
      d.cells[`${row}.${col}`];
  return v?.trim() ?? "";
};
const and = (l: string[]) =>
  l.length > 1 ? `${l.slice(0, -1).join(", ")} and ${l.at(-1)}` : l[0];

/** The Remove dialog's words; `text` is null when the size or column holds no values. */
export function removal(d: Draft, sel: Selected) {
  const t = table(d);
  if (sel.row !== undefined) {
    const ri = t.rows.findIndex((r) => r.id === sel.row);
    const size = sizeOf(d, ri);
    const vals = t.columns
      .slice(1)
      .filter((c) => valueAt(d, sel.row, c.id))
      .map((c) => `${colName(d, c.id)} ${valueAt(d, sel.row, c.id)}`);
    return {
      // Like the bar: "Remove size 2?" for a size with no name yet.
      heading: `Remove size ${valueAt(d, sel.row, t.columns[0].id) || ri + 1}?`,
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
  const measure = t.columns.find((c) => c.id === sel.col)?.kind === "measure";
  return {
    heading: `Remove the ${name} ${measure ? "measurement" : "column"}?`,
    label: measure ? "Remove measurement" : "Remove column",
    text: n
      ? `Saving removes ${name} from ${all}${n} ${n === 1 ? "size" : "sizes"}, ${n > 1 ? `${vals[0]} to ${vals[n - 1]}` : vals[0]}. Shoppers won't see a ${name} column.`
      : null,
  };
}

/**
 * The fit finder's only measurement: the one column its measure questions
 * ask. Removing it would leave the fit finder no measurement, or no questions,
 * which the save refuses, so the editor keeps it.
 */
export function fitOnly(d: Draft, col?: string) {
  const fit = d.content.fit;
  if (col === undefined || fit?.table !== table(d).id) return false;
  const asked = fit.questions.flatMap((q) =>
    q.kind === "measure" ? q.col : [],
  );
  return asked.length > 0 && asked.every((c) => c === col);
}

/**
 * Numbers stored outside Fitted in a size, text or country column, which
 * toInput leaves out: the Editor board's warning for each column that has
 * any, and the cells to mark. A value retyped as the cell's words is kept.
 */
export function dropped(d: Draft) {
  const t = table(d);
  const same = (s: string) => {
    const c = parseCell(s);
    return Array.isArray(c) ? formatCell(c) : s.trim();
  };
  return t.columns.flatMap((col) => {
    if (col.kind === "measure") return [];
    const at = t.rows.flatMap((r, ri) => {
      const v = d.cells[`${r.id}.${col.id}`] ?? "";
      const w = d.content.words[`${t.id}.${r.id}.${col.id}`] ?? "";
      return col.id in r.cells && same(w) !== same(v)
        ? [{ key: `${r.id}.${col.id}`, val: `${v} (${sizeOf(d, ri)})` }]
        : [];
    });
    const n = at.length;
    if (!n) return [];
    return [
      {
        col: col.id,
        cells: at.map((x) => x.key),
        heading: `Saving drops ${n} ${n === 1 ? "value" : "values"} in ${colName(d, col.id)}`,
        text: `They were added outside Fitted as numbers, which this column can't hold: ${and(at.map((x) => x.val))}.`,
        fix:
          n === 1
            ? "Type it in again to keep it."
            : "Type them in again to keep them.",
      },
    ];
  });
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

/**
 * The findings left once remove() takes out a size or a column: its own go,
 * and the sizes below it keep theirs, since a cell finding names its size by
 * position.
 */
export function removeErrors(
  d: Draft,
  sel: Selected,
  errors: FieldErrors,
): FieldErrors {
  const t = table(d);
  const ri = t.rows.findIndex((r) => r.id === sel.row);
  const wordAt = `content.words.${t.id}.`;
  const out: FieldErrors = {};
  for (const [k, v] of Object.entries(errors)) {
    const cell = /^content\.tables\.0\.rows\.(\d+)\.cells\.(.+)$/.exec(k);
    const [a, b] = k.startsWith(wordAt)
      ? k.slice(wordAt.length).split(".")
      : [];
    if (cell) {
      const i = Number(cell[1]);
      if (i === ri || cell[2] === sel.col) continue;
      const at = ri >= 0 && i > ri ? i - 1 : i;
      out[`content.tables.0.rows.${at}.cells.${cell[2]}`] = v;
    } else {
      const own =
        a === (sel.row ?? sel.col) || (sel.col !== undefined && b === sel.col);
      if (a === undefined || !own) out[k] = v;
    }
  }
  return out;
}

// The Editor board's table tools.
export const setRoundTo = (d: Draft, roundTo: Content["roundTo"]): Draft => ({
  ...d,
  content: { ...d.content, roundTo },
});
/** A measurement's typed unit, and whether shoppers see it converted. */
export const setMeasure = (
  d: Draft,
  col: string,
  patch: { unit?: "in" | "cm" | "lb" | "kg"; convert?: boolean },
) =>
  withTable(d, {
    columns: table(d).columns.map((c) =>
      c.id === col && c.kind === "measure" ? { ...c, ...patch } : c,
    ),
  });
export const toggleWrap = (d: Draft, col: string) => {
  const wrap = table(d).wrap ?? [];
  return withTable(d, {
    wrap: wrap.includes(col) ? wrap.filter((w) => w !== col) : [...wrap, col],
  });
};

/** The first table's merges by position. */
export function merges(d: Draft) {
  const t = table(d);
  return (t.merges ?? []).map((m) => ({
    ...m,
    r0: t.rows.findIndex((r) => r.id === m.row),
    c0: t.columns.findIndex((c) => c.id === m.col),
  }));
}
/** Cells `a` to `b` (size positions, top first) of one column. */
export type Cells = { col: string; a: number; b: number };
const spanOf = (d: Draft, s: Cells) => table(d).rows.slice(s.a, s.b + 1);
/** Two or more cells, none of them merged already. */
export const canMerge = (d: Draft, s: Cells) => {
  const ci = table(d).columns.findIndex((c) => c.id === s.col);
  return (
    s.a < s.b &&
    !merges(d).some(
      (m) =>
        m.c0 <= ci && ci < m.c0 + m.cols && m.r0 <= s.b && s.a < m.r0 + m.rows,
    )
  );
};
/**
 * The merge dialog's words. The merged cell keeps the first value in it;
 * `text` is null when no other cell holds one, so it merges straight away.
 */
export function merging(d: Draft, s: Cells) {
  const vals = spanOf(d, s).flatMap((r, i) => {
    const v = valueAt(d, r.id, s.col);
    return v ? [{ v, size: sizeOf(d, s.a + i) }] : [];
  });
  const [kept, ...lost] = vals;
  return {
    heading: `Merge ${s.b - s.a + 1} cells in ${colName(d, s.col)}?`,
    label: "Merge cells",
    text: lost.length
      ? `The merged cell keeps ${kept.size}'s value, ${kept.v}. Saving removes the other ${lost.length}: ${and(lost.map((x) => `${x.v} (${x.size})`))}.`
      : null,
  };
}
/**
 * Merges the cells: the first value moves to the top cell and the cells it
 * covers are emptied, so a save keeps no value shoppers can't see.
 */
export function merge(d: Draft, s: Cells): Draft {
  const t = table(d);
  const rows = spanOf(d, s);
  const keys = new Set(rows.map((r) => `${r.id}.${s.col}`));
  const kept = rows.map((r) => valueAt(d, r.id, s.col)).find(Boolean);
  const next = withTable(d, {
    rows: t.rows.map((r) =>
      keys.has(`${r.id}.${s.col}`)
        ? { ...r, cells: strip(r.cells, (k) => k === s.col) }
        : r,
    ),
    merges: [
      ...(t.merges ?? []),
      { row: rows[0].id, col: s.col, rows: rows.length, cols: 1 },
    ],
  });
  const top = `${rows[0].id}.${s.col}`;
  const cells = strip(d.cells, (k) => keys.has(k));
  const words = strip(
    d.content.words,
    (k) => k.startsWith(`${t.id}.`) && keys.has(k.slice(t.id.length + 1)),
  );
  if (kept && t.columns.find((c) => c.id === s.col)?.kind === "measure")
    cells[top] = kept;
  else if (kept) words[`${t.id}.${top}`] = kept;
  return { ...next, cells, content: { ...next.content, words } };
}
export const unmerge = (d: Draft, row: string, col: string) =>
  withTable(d, {
    merges: (table(d).merges ?? []).filter(
      (m) => m.row !== row || m.col !== col,
    ),
  });
