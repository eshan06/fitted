// Size charts as `$app:chart` metaobjects (ARCHITECTURE §5). Every write goes
// through validateChart: the editor, imports, restores, templates, duplicates
// and OpenAI output.

export const TEMPLATES = [
  "blank",
  "tops",
  "bottoms",
  "dresses",
  "bras_swimwear",
  "shoes",
  "kids",
  "headwear",
  "rings",
  "bracelets",
  "necklaces",
] as const;
export type Template = (typeof TEMPLATES)[number];
type Cell = [number] | [number, number];
export type Column =
  | { id: string; kind: "size" | "text" }
  | { id: string; kind: "country"; country: "US" | "UK" | "EU" | "AU" }
  | {
      id: string;
      kind: "measure";
      unit?: "in" | "cm" | "lb" | "kg";
      convert: boolean;
    };
export type Table = {
  id: string;
  columns: Column[];
  rows: { id: string; cells: Record<string, Cell> }[];
  merges?: { row: string; col: string; rows: number; cols: number }[];
  wrap?: string[];
};
export type Question =
  | { id: string; kind: "measure"; col: string; optional: boolean }
  | { id: string; kind: "usual_size" | "fit" }
  | { id: string; kind: "choice"; options: { id: string; rows: string[] }[] };
export type Fit = {
  table: string;
  questions: Question[];
  ease: Record<string, number>;
  stretch: "none" | "some" | "high";
};
export type Content = {
  v: 1;
  unit: "in" | "cm";
  roundTo: 0.25 | 0.5 | 1;
  tables: Table[];
  measure: { steps: string[] };
  videoUrl?: string;
  fit?: Fit;
  words: Record<string, string>;
};
export type ChartInput = {
  name: string;
  template: Template;
  content: Content;
  measureImage?: string;
  importNote?: string;
};

export type FieldErrors = Record<string, string>;
export class ChartValidationError extends Error {
  constructor(readonly fieldErrors: FieldErrors) {
    super("The chart has invalid fields");
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const ID = /^[a-z0-9]{1,8}$/;
const RESERVED = new Set(["title", "sub", "note"]);
const IMAGE = /^gid:\/\/shopify\/MediaImage\/\d+$/;
const VIDEO_HOST =
  /^((www\.|m\.)?youtube\.com|youtu\.be|(www\.|player\.)?vimeo\.com)$/;
const oneOf = (v: unknown, list: readonly unknown[]) => list.includes(v);

export function validateChart(input: unknown): ChartInput {
  // No prototype, so keys like "__proto__" or "constructor" are recorded too.
  const errs: FieldErrors = Object.create(null);
  const fail = (path: string, message: string) => (errs[path] ??= message);
  const only = (o: Record<string, unknown>, allowed: string[], path: string) =>
    Object.keys(o).forEach(
      (k) =>
        allowed.includes(k) || fail(path ? `${path}.${k}` : k, "Unknown field"),
    );
  const list = (
    v: unknown,
    path: string,
    min: number,
    max: number,
  ): unknown[] => {
    if (!Array.isArray(v)) {
      fail(path, "Must be a list");
      return [];
    }
    if (v.length < min || v.length > max)
      fail(path, `Must have ${min} to ${max} items`);
    return v.slice(0, max);
  };
  const ids = new Set<string>();
  const id = (v: unknown, path: string, seen = ids): v is string => {
    let problem = "";
    if (typeof v !== "string" || !ID.test(v))
      problem = "Use 1 to 8 lowercase letters or digits";
    else if (RESERVED.has(v)) problem = `"${v}" is reserved`;
    else if (seen.has(v)) problem = `"${v}" is already used`;
    else seen.add(v);
    if (problem) fail(path, problem);
    return !problem;
  };
  const words = new Set<string>(["tips"]);

  if (!isObj(input)) throw new ChartValidationError({ "": "Must be a chart" });
  only(
    input,
    ["name", "template", "content", "measureImage", "importNote"],
    "",
  );
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100 || /[\r\n]/.test(name))
    fail("name", "Give the chart a one-line name of at most 100 characters");
  if (!oneOf(input.template, TEMPLATES)) fail("template", "Pick a template");
  if (
    input.measureImage !== undefined &&
    (typeof input.measureImage !== "string" || !IMAGE.test(input.measureImage))
  )
    fail("measureImage", "Must be an uploaded image");
  if (
    input.importNote !== undefined &&
    (typeof input.importNote !== "string" ||
      input.importNote.length > 255 ||
      /[\r\n]/.test(input.importNote))
  )
    fail("importNote", "Must be one line of at most 255 characters");

  const c = input.content;
  if (!isObj(c))
    throw new ChartValidationError({
      ...errs,
      content: "Must be chart content",
    });
  // Checked first, so oversized input never gets walked key by key. Nesting
  // too deep to serialize throws RangeError, which counts as too large.
  let bytes = Infinity;
  try {
    bytes = Buffer.byteLength(JSON.stringify(c));
  } catch {
    // stays Infinity
  }
  if (bytes >= 100 * 1024)
    throw new ChartValidationError({
      ...errs,
      content: "The chart is too large; split it into smaller charts",
    });
  only(
    c,
    ["v", "unit", "roundTo", "tables", "measure", "videoUrl", "fit", "words"],
    "content",
  );
  if (c.v !== 1) fail("content.v", "Must be 1");
  if (!oneOf(c.unit, ["in", "cm"]))
    fail("content.unit", "Pick inches or centimeters");
  if (!oneOf(c.roundTo, [0.25, 0.5, 1]))
    fail("content.roundTo", "Pick 0.25, 0.5 or 1");

  const tables = new Map<
    string,
    { measures: Set<string>; rows: Set<string> }
  >();
  list(c.tables, "content.tables", 1, 4).forEach((t, ti) => {
    const p = `content.tables.${ti}`;
    if (!isObj(t)) return fail(p, "Must be a table");
    only(t, ["id", "columns", "rows", "merges", "wrap"], p);
    if (!id(t.id, `${p}.id`)) return;
    ["title", "sub", "note"].forEach((k) => words.add(`${t.id}.${k}`));
    const cols: string[] = [];
    const measures = new Set<string>();
    list(t.columns, `${p}.columns`, 1, 20).forEach((col, ci) => {
      const cp = `${p}.columns.${ci}`;
      if (!isObj(col) || !id(col.id, `${cp}.id`))
        return isObj(col) || fail(cp, "Must be a column");
      cols.push(col.id);
      words.add(`${t.id}.${col.id}`);
      if ((ci === 0) !== (col.kind === "size"))
        fail(`${cp}.kind`, "The first column, and only it, is the size column");
      if (col.kind === "size" || col.kind === "text")
        only(col, ["id", "kind"], cp);
      else if (col.kind === "country") {
        only(col, ["id", "kind", "country"], cp);
        if (!oneOf(col.country, ["US", "UK", "EU", "AU"]))
          fail(`${cp}.country`, "Pick US, UK, EU or AU");
      } else if (col.kind === "measure") {
        only(col, ["id", "kind", "unit", "convert"], cp);
        measures.add(col.id);
        if (
          col.unit !== undefined &&
          !oneOf(col.unit, ["in", "cm", "lb", "kg"])
        )
          fail(`${cp}.unit`, "Pick in, cm, lb or kg");
        if (typeof col.convert !== "boolean")
          fail(`${cp}.convert`, "Must be true or false");
      } else fail(`${cp}.kind`, "Unknown column kind");
    });
    const rows: string[] = [];
    list(t.rows, `${p}.rows`, 1, 60).forEach((row, ri) => {
      const rp = `${p}.rows.${ri}`;
      if (!isObj(row)) return fail(rp, "Must be a row");
      only(row, ["id", "cells"], rp);
      if (!id(row.id, `${rp}.id`)) return;
      rows.push(row.id);
      cols
        .filter((col) => !measures.has(col))
        .forEach((col) => words.add(`${t.id}.${row.id}.${col}`));
      if (!isObj(row.cells)) return fail(`${rp}.cells`, "Must be cells");
      for (const [col, cell] of Object.entries(row.cells)) {
        const ok =
          Array.isArray(cell) &&
          (cell.length === 1 || cell.length === 2) &&
          cell.every((n) => typeof n === "number" && n > 0 && n < 10000) &&
          (cell.length === 1 || cell[0] <= cell[1]);
        if (!measures.has(col))
          fail(`${rp}.cells.${col}`, "Not a measurement column");
        else if (!ok)
          fail(
            `${rp}.cells.${col}`,
            "Use a number above 0 and below 10,000, or a range from low to high",
          );
      }
    });
    const covered = new Set<string>();
    list(
      t.merges === undefined ? [] : t.merges,
      `${p}.merges`,
      0,
      1200,
    ).forEach((m, mi) => {
      const mp = `${p}.merges.${mi}`;
      const r0 = isObj(m) ? rows.indexOf(m.row as string) : -1;
      const c0 = isObj(m) ? cols.indexOf(m.col as string) : -1;
      if (!isObj(m) || r0 < 0 || c0 < 0)
        return fail(mp, "Must name a row and column of this table");
      only(m, ["row", "col", "rows", "cols"], mp);
      const span = (n: unknown, max: number) =>
        Number.isInteger(n) && (n as number) >= 1 && (n as number) <= max;
      if (!span(m.rows, rows.length - r0) || !span(m.cols, cols.length - c0))
        return fail(mp, "Must stay inside the table");
      for (let r = r0; r < r0 + (m.rows as number); r++)
        for (let k = c0; k < c0 + (m.cols as number); k++)
          if (covered.has(`${r},${k}`))
            return fail(mp, "Overlaps another merge");
          else covered.add(`${r},${k}`);
    });
    list(t.wrap === undefined ? [] : t.wrap, `${p}.wrap`, 0, 20).forEach(
      (w, wi) =>
        cols.includes(w as string) ||
        fail(`${p}.wrap.${wi}`, "Not a column of this table"),
    );
    tables.set(t.id, { measures, rows: new Set(rows) });
  });

  if (!isObj(c.measure))
    fail("content.measure", "Must list the measuring steps");
  else {
    only(c.measure, ["steps"], "content.measure");
    list(c.measure.steps, "content.measure.steps", 0, 20).forEach((s, si) => {
      if (id(s, `content.measure.steps.${si}`))
        words.add(`m.${s}.name`).add(`m.${s}.text`);
    });
  }

  if (c.videoUrl !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(String(c.videoUrl));
    } catch {
      // reported below
    }
    if (
      typeof c.videoUrl !== "string" ||
      url?.protocol !== "https:" ||
      !VIDEO_HOST.test(url.hostname)
    )
      fail("content.videoUrl", "Use an https YouTube or Vimeo link");
  }

  if (c.fit !== undefined) {
    const f = c.fit;
    const table = isObj(f) ? tables.get(f.table as string) : undefined;
    if (!isObj(f) || !table)
      fail("content.fit", "Must name one of the chart's tables");
    else {
      only(f, ["table", "questions", "ease", "stretch"], "content.fit");
      if (!oneOf(f.stretch, ["none", "some", "high"]))
        fail("content.fit.stretch", "Pick none, some or high");
      if (!isObj(f.ease))
        fail("content.fit.ease", "Must be ease per measurement column");
      else
        for (const [col, n] of Object.entries(f.ease))
          if (
            !table.measures.has(col) ||
            typeof n !== "number" ||
            Math.abs(n) >= 10000
          )
            fail(
              `content.fit.ease.${col}`,
              "Must be a number for a measurement column",
            );
      list(f.questions, "content.fit.questions", 1, 6).forEach((q, qi) => {
        const qp = `content.fit.questions.${qi}`;
        if (!isObj(q) || !id(q.id, `${qp}.id`))
          return isObj(q) || fail(qp, "Must be a question");
        words.add(`fit.${q.id}`);
        if (q.kind === "measure") {
          only(q, ["id", "kind", "col", "optional"], qp);
          if (!table.measures.has(q.col as string))
            fail(`${qp}.col`, "Must be a measurement column of the fit table");
          if (typeof q.optional !== "boolean")
            fail(`${qp}.optional`, "Must be true or false");
        } else if (q.kind === "usual_size" || q.kind === "fit")
          only(q, ["id", "kind"], qp);
        else if (q.kind === "choice") {
          only(q, ["id", "kind", "options"], qp);
          const seen = new Set<string>();
          list(q.options, `${qp}.options`, 1, 20).forEach((o, oi) => {
            const op = `${qp}.options.${oi}`;
            if (!isObj(o) || !id(o.id, `${op}.id`, seen))
              return isObj(o) || fail(op, "Must be an option");
            words.add(`fit.${q.id}.${o.id}`);
            only(o, ["id", "rows"], op);
            list(o.rows, `${op}.rows`, 1, 60).forEach(
              (r, ri) =>
                table.rows.has(r as string) ||
                fail(`${op}.rows.${ri}`, "Not a row of the fit table"),
            );
          });
        } else fail(`${qp}.kind`, "Unknown question kind");
      });
    }
  }

  if (!isObj(c.words)) fail("content.words", "Must be the chart's words");
  else
    for (const [k, w] of Object.entries(c.words)) {
      const max = k === "tips" ? 2000 : 500;
      if (!words.has(k))
        fail(`content.words.${k}`, "Not a word this chart uses");
      else if (typeof w !== "string" || w.length > max)
        fail(`content.words.${k}`, `Must be text of at most ${max} characters`);
    }

  if (Object.keys(errs).length) throw new ChartValidationError(errs);
  const out: ChartInput = {
    name,
    template: input.template as Template,
    content: c as Content,
  };
  if (input.measureImage) out.measureImage = input.measureImage as string;
  if (input.importNote) out.importNote = input.importNote as string;
  return out;
}
