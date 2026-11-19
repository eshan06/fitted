// The shopper's size guide (ARCHITECTURE §9): re-validates the chart Liquid
// printed and draws the Size chart tab. No dependencies and no React, so the
// admin preview (#23) can draw with it too. Chart words reach the page only
// as text nodes and attribute values, never as HTML.
import { convert, type Column, type Table, type Unit } from "./fit-finder";

type Sys = "in" | "cm"; // inches and pounds, or centimeters and kilograms
export type Guide = {
  unit: "in" | "cm";
  roundTo: number;
  tables: Table[];
  words: Record<string, string>; // content.words under the shopper's translations
  sys: Sys; // the units the guide shows
  locale: string;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
// §5's id rule, which also keeps ids off Object.prototype's keys.
const isId = (v: unknown) => isStr(v) && /^[a-z0-9]{1,8}$/.test(v);
const list = (v: unknown, max: number): v is unknown[] =>
  Array.isArray(v) && v.length > 0 && v.length <= max;
const isNum = (n: unknown) => typeof n === "number" && n > 0 && n < 10000;
const isCell = (c: unknown) =>
  Array.isArray(c) &&
  c.every(isNum) &&
  (c.length === 1 || (c.length === 2 && c[0] <= c[1]));
const isColumn = (c: unknown, i: number): c is Column =>
  isObj(c) &&
  isId(c.id) &&
  (i === 0) === (c.kind === "size") &&
  (c.kind === "size" ||
    c.kind === "text" ||
    (c.kind === "country" &&
      ["US", "UK", "EU", "AU"].includes(c.country as string)) ||
    (c.kind === "measure" &&
      typeof c.convert === "boolean" &&
      (c.unit === undefined ||
        ["in", "cm", "lb", "kg"].includes(c.unit as string))));
const isRow = (r: unknown) =>
  isObj(r) &&
  isId(r.id) &&
  isObj(r.cells) &&
  Object.values(r.cells).every(isCell);
const isTable = (t: unknown): t is Table =>
  isObj(t) &&
  isId(t.id) &&
  list(t.columns, 20) &&
  t.columns.every(isColumn) &&
  list(t.rows, 60) &&
  t.rows.every(isRow);
// Only text values: other words are dropped, as translations can come from any app (§11).
const texts = (v: unknown) =>
  Object.fromEntries(
    Object.entries(isObj(v) ? v : {}).filter(([, w]) => isStr(w)),
  ) as Record<string, string>;

/** The chart a block printed, or null when there is none a shopper can see. */
export function parseGuide(json: string | null | undefined): Guide | null {
  let d: unknown;
  try {
    d = JSON.parse(json ?? "");
  } catch {
    return null;
  }
  if (!isObj(d) || !isObj(d.chart)) return null;
  const { v, unit, roundTo, tables, words } = d.chart;
  if (
    v !== 1 ||
    (unit !== "in" && unit !== "cm") ||
    (roundTo !== 0.25 && roundTo !== 0.5 && roundTo !== 1) ||
    !list(tables, 4) ||
    !tables.every(isTable) ||
    !isObj(words)
  )
    return null;
  const units = isObj(d.units) ? d.units : {};
  return {
    unit,
    roundTo,
    tables,
    words: { ...texts(words), ...texts(d.strings) },
    sys:
      units.default === "in" || units.default === "cm"
        ? units.default
        : ["US", "LR", "MM"].includes(d.country as string)
          ? "in"
          : "cm",
    locale: isStr(d.locale) ? d.locale : "en",
  };
}

type Kid = Node | string | false | null | undefined;
/** An element built with DOM calls, so no value is ever parsed as HTML. */
export function h(
  tag: string,
  attrs: Record<string, string | undefined> = {},
  ...kids: Kid[]
) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs))
    if (v !== undefined) el.setAttribute(k, v);
  el.append(...kids.filter((k): k is Node | string => !!k));
  return el;
}

// Where a measure column's numbers show: as typed, or in the shopper's units.
const shown = (u: Unit, conv: boolean, sys: Sys): Unit =>
  !conv ? u : u === "in" || u === "cm" ? sys : sys === "in" ? "lb" : "kg";

/** Draws the Size chart tab into root; its data-t-chart names a table without a title. */
export function render(root: HTMLElement, g: Guide) {
  const nf = new Intl.NumberFormat(g.locale, { maximumFractionDigits: 4 });
  const word = (k: string) => g.words[k] ?? "";
  const note = (k: string) =>
    word(k) && h("p", { class: "fitted-note" }, word(k));
  const number = (n: number, from: Unit, to: Unit) =>
    nf.format(
      from === to
        ? n
        : Math.round((convert(n, from, to) ?? n) / g.roundTo) * g.roundTo,
    );
  const table = (tb: Table): Kid[] => {
    const head = tb.columns.map((c) => {
      let text = word(`${tb.id}.${c.id}`);
      if (c.kind === "country") text ||= c.country;
      if (c.kind === "measure")
        text += ` (${shown(c.unit ?? g.unit, c.convert, g.sys)})`;
      return h("th", { scope: "col" }, text);
    });
    const rows = tb.rows.map((row) =>
      h(
        "tr",
        {},
        ...tb.columns.map((c, i) => {
          const text = word(`${tb.id}.${row.id}.${c.id}`);
          if (i === 0) return h("th", { scope: "row" }, text);
          if (c.kind !== "measure") return h("td", {}, text);
          const from = c.unit ?? g.unit;
          const to = shown(from, c.convert, g.sys);
          const cell = row.cells[c.id]?.map((n) => number(n, from, to));
          return h("td", {}, cell?.join("–"));
        }),
      ),
    );
    const title = word(`${tb.id}.title`);
    return [
      g.tables.length > 1 && title && h("h3", { class: "fitted-h3" }, title),
      note(`${tb.id}.sub`),
      h(
        "div",
        { class: "fitted-scroll" },
        h(
          "table",
          { class: "fitted-table" },
          h("caption", { class: "fitted-sr" }, title || root.dataset.tChart),
          h("thead", {}, h("tr", {}, ...head)),
          h("tbody", {}, ...rows),
        ),
      ),
      note(`${tb.id}.note`),
    ];
  };
  const kids = [...g.tables.flatMap(table), note("tips")];
  root.replaceChildren(...kids.filter((k): k is Node => !!k));
}
