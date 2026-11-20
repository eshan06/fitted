// Size charts as `$app:chart` metaobjects (ARCHITECTURE §5). Every write goes
// through validateChart: the editor, imports, restores, templates, duplicates
// and OpenAI output.
import { isDeepStrictEqual } from "node:util";
import { type Admin, AdminApiError, adminGraphql } from "./admin.server";

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
  // NUL never round-trips: CSV import refuses it and Postgres json can't hold it.
  if (name.includes("\0")) fail("name", "Remove the hidden NUL character");
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
      /[\r\n\0]/.test(input.importNote))
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
      c.videoUrl.includes("\0") ||
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
      else if (w.includes("\0"))
        fail(`content.words.${k}`, "Remove the hidden NUL character");
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

// Reads and writes (§5, §15). Each error maps to one status: ChartNotFoundError
// 404, ChartConflictError 409, ChartValidationError 422, AdminApiError 502.
export class ChartNotFoundError extends Error {
  constructor() {
    super("Chart not found");
  }
}
export class ChartConflictError extends Error {}

export type ChartStatus = "ACTIVE" | "DRAFT";
// A stored chart that fails validation keeps its row, with fieldErrors and its
// raw fields in place of chart, so screens can show the error on it instead of
// dropping it, and the editor can open it to be fixed.
export type StoredChart = {
  id: string;
  handle: string;
  status: ChartStatus;
  updatedAt: string;
  name: string;
} & (
  | { chart: ChartInput; fieldErrors?: undefined; raw?: undefined }
  | {
      chart?: undefined;
      fieldErrors: FieldErrors;
      raw: Record<string, unknown>;
    }
);

const TYPE = "$app:chart";
const GID = /^gid:\/\/shopify\/Metaobject\/\d+$/;
// Minted by the new-chart screen (§5); imports add their own form with #26.
const HANDLE = /^c-[a-z0-9]{10}$/;
const FIELDS = `#graphql
  fragment ChartFields on Metaobject {
    id
    handle
    type
    updatedAt
    capabilities { publishable { status } }
    name: field(key: "name") { value }
    template: field(key: "template") { value }
    content: field(key: "content") { jsonValue }
    measureImage: field(key: "measure_image") { value }
    importNote: field(key: "import_note") { value }
  }`;
const UPDATE = `#graphql
  ${FIELDS}
  mutation ChartUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject { ...ChartFields }
      userErrors { field message code }
    }
  }`;

type Field = { value?: string | null; jsonValue?: unknown } | null;
type Node = {
  id: string;
  handle: string;
  type: string;
  updatedAt: string;
  capabilities: { publishable: { status: ChartStatus } | null };
  name: Field;
  template: Field;
  content: Field;
  measureImage: Field;
  importNote: Field;
};

function fromNode(n: Node): StoredChart {
  const raw: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v != null) raw[k] = v;
  };
  put("name", n.name?.value);
  put("template", n.template?.value);
  put("content", n.content?.jsonValue);
  put("measureImage", n.measureImage?.value);
  put("importNote", n.importNote?.value);
  const meta = {
    id: n.id,
    handle: n.handle,
    status: n.capabilities.publishable?.status ?? "DRAFT",
    updatedAt: n.updatedAt,
    name: n.name?.value ?? "",
  };
  try {
    return { ...meta, chart: validateChart(raw) };
  } catch (err) {
    if (err instanceof ChartValidationError)
      return { ...meta, fieldErrors: err.fieldErrors, raw };
    throw err;
  }
}

// json fields take a JSON string; metaobjectUpdate's `values` replaces the
// whole record, so an omitted measure_image or import_note is cleared.
const values = (c: ChartInput) => ({
  name: c.name,
  template: c.template,
  content: JSON.stringify(c.content),
  strings: JSON.stringify(c.content.words),
  ...(c.measureImage && { measure_image: c.measureImage }),
  ...(c.importNote && { import_note: c.importNote }),
});

const notFound = (err: unknown) =>
  err instanceof AdminApiError &&
  err.userErrors.some((e) => e.code === "RECORD_NOT_FOUND");

// A chart deleted between our read and our write comes back as a user error.
async function write(admin: Admin, variables: Record<string, unknown>) {
  try {
    const data = await adminGraphql<{
      metaobjectUpdate: { metaobject: Node };
    }>(admin, UPDATE, variables);
    return fromNode(data.metaobjectUpdate.metaobject);
  } catch (err) {
    throw notFound(err) ? new ChartNotFoundError() : err;
  }
}

// Newest first, for the charts list; `byId` pages in a fixed order instead.
export async function listCharts(admin: Admin, after?: string, byId = false) {
  const data = await adminGraphql<{
    metaobjects: {
      nodes: Node[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(
    admin,
    `#graphql
    ${FIELDS}
    query ChartList($after: String, $sortKey: String, $reverse: Boolean) {
      metaobjects(type: "${TYPE}", first: 50, after: $after, sortKey: $sortKey, reverse: $reverse) {
        nodes { ...ChartFields }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    {
      after: after ?? null,
      sortKey: byId ? "id" : "updated_at",
      reverse: !byId,
    },
    { retry: true },
  );
  const { nodes, pageInfo } = data.metaobjects;
  return {
    charts: nodes.map(fromNode),
    next: pageInfo.hasNextPage ? pageInfo.endCursor : null,
  };
}

// Every chart, a page at a time, for CSV export and Free's limit. In id
// order: a chart saved meanwhile would move in an updated_at listing, so a
// read across pages would skip it or see it twice.
export async function* chartPages(admin: Admin) {
  let after: string | undefined;
  do {
    const page = await listCharts(admin, after, true);
    yield page.charts;
    after = page.next ?? undefined;
  } while (after);
}

// How many products show each chart (§6), for the charts list. Shopify counts
// up to 10,000; `atLeast` marks a count that reached that cap.
export async function countChartProducts(admin: Admin, ids: string[]) {
  const counts: Record<string, { count: number; atLeast: boolean }> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await adminGraphql<
      Record<string, { count: number; precision: string }>
    >(
      admin,
      `#graphql
      query ChartProductCounts(${batch.map((_, j) => `$q${j}: String`).join(", ")}) {
        ${batch.map((_, j) => `c${j}: productsCount(query: $q${j}) { count precision }`).join("\n")}
      }`,
      Object.fromEntries(
        batch.map((id, j) => [`q${j}`, `metafields.$app.chart:"${id}"`]),
      ),
      { retry: true },
    );
    batch.forEach((id, j) => {
      const { count, precision } = data[`c${j}`];
      counts[id] = { count, atLeast: precision !== "EXACT" };
    });
  }
  return counts;
}

// For Free's limit of Active charts (§8).
// ponytail: pages through every chart; filter by status in the query if stores keep hundreds of drafts.
export async function countActiveCharts(admin: Admin) {
  let count = 0;
  for await (const charts of chartPages(admin))
    count += charts.filter((c) => c.status === "ACTIVE").length;
  return count;
}

// The id comes from a browser: it must be a metaobject of this app's chart
// type, or it is not found.
export async function getChart(admin: Admin, id: unknown) {
  if (typeof id !== "string" || !GID.test(id)) throw new ChartNotFoundError();
  const data = await adminGraphql<{
    metaobject: Node | null;
    metaobjectDefinitionByType: { type: string } | null;
  }>(
    admin,
    `#graphql
    ${FIELDS}
    query ChartGet($id: ID!) {
      metaobject(id: $id) { ...ChartFields }
      metaobjectDefinitionByType(type: "${TYPE}") { type }
    }`,
    { id },
    { retry: true },
  );
  const n = data.metaobject;
  if (!n || n.type !== data.metaobjectDefinitionByType?.type)
    throw new ChartNotFoundError();
  return fromNode(n);
}

// Created as a Draft by handle, so a retried create lands on the same chart.
export async function createChart(
  admin: Admin,
  handle: unknown,
  input: unknown,
) {
  if (typeof handle !== "string" || !HANDLE.test(handle))
    throw new ChartValidationError({ handle: "Reload the page and try again" });
  const chart = validateChart(input);
  const key = { type: TYPE, handle };
  const { metaobjectByHandle: existing } = await adminGraphql<{
    metaobjectByHandle: Node | null;
  }>(
    admin,
    `#graphql
    ${FIELDS}
    query ChartByHandle($handle: MetaobjectHandleInput!) {
      metaobjectByHandle(handle: $handle) { ...ChartFields }
    }`,
    { handle: key },
    { retry: true },
  );
  if (existing) {
    const stored = fromNode(existing);
    // Compared as stored JSON, so keys holding undefined don't count.
    if (isDeepStrictEqual(stored.chart, JSON.parse(JSON.stringify(chart))))
      return stored;
    throw new ChartConflictError("Another chart already uses this handle");
  }
  const data = await adminGraphql<{
    metaobjectUpsert: { metaobject: Node };
  }>(
    admin,
    `#graphql
    ${FIELDS}
    mutation ChartCreate($handle: MetaobjectHandleInput!, $fields: [MetaobjectFieldInput!]!) {
      metaobjectUpsert(handle: $handle, metaobject: { fields: $fields, capabilities: { publishable: { status: DRAFT } } }) {
        metaobject { ...ChartFields }
        userErrors { field message code }
      }
    }`,
    {
      handle: key,
      fields: Object.entries(values(chart)).map(([k, value]) => ({
        key: k,
        value,
      })),
    },
    { retry: true },
  );
  return fromNode(data.metaobjectUpsert.metaobject);
}

// ponytail: read-then-write, and updatedAt has whole-second precision, so two
// saves in the same second can both pass. Shopify has no compare-and-swap for
// metaobjects; a version counter in content would close it if it ever bites.
export async function updateChart(
  admin: Admin,
  id: unknown,
  input: unknown,
  loadedUpdatedAt: unknown,
) {
  const chart = validateChart(input);
  const current = await getChart(admin, id);
  if (current.updatedAt !== loadedUpdatedAt)
    throw new ChartConflictError("This chart changed since you opened it");
  return write(admin, {
    id: current.id,
    metaobject: { values: values(chart) },
  });
}

async function setStatus(admin: Admin, id: unknown, status: ChartStatus) {
  const current = await getChart(admin, id);
  // A chart that fails validation never reaches shoppers.
  if (status === "ACTIVE" && current.fieldErrors)
    throw new ChartValidationError(current.fieldErrors);
  return write(admin, {
    id: current.id,
    metaobject: { capabilities: { publishable: { status } } },
  });
}
export const publishChart = (admin: Admin, id: unknown) =>
  setStatus(admin, id, "ACTIVE");
export const unpublishChart = (admin: Admin, id: unknown) =>
  setStatus(admin, id, "DRAFT");

export async function deleteChart(admin: Admin, id: unknown) {
  const current = await getChart(admin, id);
  try {
    await adminGraphql(
      admin,
      `#graphql
      mutation ChartDelete($id: ID!) {
        metaobjectDelete(id: $id) {
          deletedId
          userErrors { field message code }
        }
      }`,
      { id: current.id },
    );
  } catch (err) {
    // Deleted by someone else in the meantime: it is gone either way.
    if (!notFound(err)) throw err;
  }
}
