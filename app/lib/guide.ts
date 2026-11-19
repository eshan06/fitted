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
  sys: Sys; // the units the guide opens in
  toggle: boolean;
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
// Only text values: translations can come from any app (§11).
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
    !isObj(words) ||
    !Object.values(words).every(isStr)
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
    toggle: units.toggle !== false,
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

/** Draws the Size chart tab into root, whose data-t-* attributes hold the interface words. */
export function render(root: HTMLElement, g: Guide) {
  const t = root.dataset;
  let nf: Intl.NumberFormat;
  try {
    nf = new Intl.NumberFormat(g.locale, { maximumFractionDigits: 2 });
  } catch {
    nf = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
  }
  const word = (k: string) => g.words[k] ?? "";
  const note = (k: string) =>
    word(k) && h("p", { class: "fitted-note" }, word(k));
  const countries = (tb: Table) =>
    tb.columns.flatMap((c) => (c.kind === "country" ? [c.country] : []));
  // Country columns show one at a time when a table has two or more (§5).
  const regions = [
    ...new Set(
      g.tables.flatMap((tb) => (countries(tb).length > 1 ? countries(tb) : [])),
    ),
  ];
  const toggle =
    g.toggle &&
    g.tables.some((tb) =>
      tb.columns.some((c) => c.kind === "measure" && c.convert),
    );
  const st: { sys: Sys; region?: string } = { sys: g.sys, region: regions[0] };
  const number = (n: number, from: Unit, to: Unit) =>
    nf.format(
      from === to
        ? n
        : Math.round((convert(n, from, to) ?? n) / g.roundTo) * g.roundTo,
    );

  const table = (tb: Table): Kid[] => {
    const cs = countries(tb);
    const region = cs.find((c) => c === st.region) ?? cs[0];
    const cols = tb.columns.filter(
      (c) => c.kind !== "country" || cs.length < 2 || c.country === region,
    );
    const head = cols.map((c) => {
      let text = word(`${tb.id}.${c.id}`);
      if (c.kind === "country") text ||= c.country;
      if (c.kind === "measure") {
        const u = shown(c.unit ?? g.unit, c.convert, st.sys);
        if (!toggle || u !== st.sys) text += ` (${u})`;
      }
      return h("th", { scope: "col" }, text);
    });
    const rows = tb.rows.map((row) =>
      h(
        "tr",
        {},
        ...cols.map((c, i) => {
          const text = word(`${tb.id}.${row.id}.${c.id}`);
          if (i === 0) return h("th", { scope: "row" }, text);
          if (c.kind !== "measure") return h("td", {}, text);
          const from = c.unit ?? g.unit;
          const to = shown(from, c.convert, st.sys);
          const cell = row.cells[c.id];
          return h(
            "td",
            {},
            cell && cell.map((n) => number(n, from, to)).join("–"),
          );
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
          h("caption", { class: "fitted-sr" }, title || t.tChart),
          h("thead", {}, h("tr", {}, ...head)),
          h("tbody", {}, ...rows),
        ),
      ),
      note(`${tb.id}.note`),
    ];
  };
  const seg = (
    name: string | undefined,
    key: string,
    values: string[],
    on?: string,
  ) =>
    h(
      "div",
      { role: "group", "aria-label": name, class: "fitted-seg" },
      ...values.map((v) =>
        h(
          "button",
          { type: "button", [`data-${key}`]: v, "aria-pressed": `${v === on}` },
          v,
        ),
      ),
    );

  // Redrawn whole on every change; focus returns to the same control. Its
  // value is a unit or a country code, which parseGuide limited, so it is
  // safe inside the selector.
  const draw = () => {
    const active = document.activeElement;
    const was =
      active instanceof HTMLElement && root.contains(active)
        ? active.dataset
        : undefined;
    const kids: Kid[] = [
      (regions.length > 1 || toggle) &&
        h(
          "div",
          { class: "fitted-controls" },
          regions.length > 1 && seg(t.tSystem, "region", regions, st.region),
          toggle && seg(t.tUnits, "unit", ["in", "cm"], st.sys),
        ),
      ...g.tables.flatMap(table),
      note("tips"),
    ];
    root.replaceChildren(...kids.filter((k): k is Node => !!k));
    const again = was?.unit
      ? `[data-unit="${was.unit}"]`
      : was?.region && `[data-region="${was.region}"]`;
    if (again) root.querySelector<HTMLElement>(again)?.focus();
  };
  root.addEventListener("click", (e) => {
    const el = (e.target as Element).closest<HTMLElement>(
      "[data-unit], [data-region]",
    );
    if (!el) return;
    if (el.dataset.unit) st.sys = el.dataset.unit as Sys;
    else st.region = el.dataset.region;
    draw();
  });
  draw();
}
