// The shopper's size guide (ARCHITECTURE §9): re-validates the chart Liquid
// printed and draws the Size chart tab: the US/UK/EU/AU and in/cm switches,
// the tables, row select, and the footer that picks the size in the theme's
// product form, and on Pro the Find my size tab (§10). No dependencies and
// no React, so the admin preview (#23) can draw with it too. Chart words reach
// the page only as text nodes and attribute values, never as HTML.
import { COLOR, FONT_URL, cssProblem } from "./appearance";
import {
  convert,
  findSize,
  type Answers,
  type Column,
  type Fit,
  type FitResult,
  type Question,
  type Table,
  type Unit,
} from "./fit-finder";
import { tableCss } from "./guide-css";

type Sys = "in" | "cm"; // inches and pounds, or centimeters and kilograms
type Measure = Extract<Column, { kind: "measure" }>;
type Grid = Table & {
  merges?: { row: string; col: string; rows: number; cols: number }[];
  wrap?: string[];
};
export type Guide = {
  unit: "in" | "cm";
  roundTo: number;
  tables: Grid[];
  words: Record<string, string>; // content.words under the shopper's translations
  sys: Sys; // the units the guide opens in
  toggle: boolean; // settings.units.toggle: the shopper may switch units
  country: string; // the shopper's, which picks the size system shown first
  locale: string;
  // The Appearance settings (§7); "" or null where the extension's or the theme's apply.
  label: string; // the link's text
  header: string; // the popup's title
  icon: "ruler" | "none";
  rtl: boolean;
  font: string; // an uploaded font's URL
  colors: { text: string; accent: string; bg: string } | null;
  css: string; // custom CSS
  // Where it shows (§7 placement).
  page: boolean; // the app block's link on its product page
  quick: boolean; // in a theme's quick view
  featured: boolean; // in a featured product section
  selector: string; // the element the app embed's link goes after
  raw: Record<string, unknown>; // all the snippet printed, for guide.js
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
// §5's merges stay inside their table and never overlap; wrap names columns.
const isLayout = (t: Table & { merges?: unknown; wrap?: unknown }) => {
  const rows = t.rows.map((r) => r.id);
  const cols = t.columns.map((c) => c.id);
  const span = (n: unknown, room: number) =>
    Number.isInteger(n) && (n as number) >= 1 && (n as number) <= room;
  const taken = new Set<string>();
  const fits = (m: unknown) => {
    const r = isObj(m) ? rows.indexOf(m.row as string) : -1;
    const c = isObj(m) ? cols.indexOf(m.col as string) : -1;
    if (r < 0 || c < 0) return false;
    const { rows: h, cols: w } = m as { rows: number; cols: number };
    if (!span(h, rows.length - r) || !span(w, cols.length - c)) return false;
    for (let i = r; i < r + h; i++)
      for (let j = c; j < c + w; j++) {
        if (taken.has(`${i},${j}`)) return false;
        taken.add(`${i},${j}`);
      }
    return true;
  };
  return (
    (t.wrap === undefined ||
      (Array.isArray(t.wrap) && t.wrap.every((w) => cols.includes(w)))) &&
    (t.merges === undefined ||
      (Array.isArray(t.merges) && t.merges.every(fits)))
  );
};
const isTable = (t: unknown): t is Grid =>
  isObj(t) &&
  isId(t.id) &&
  list(t.columns, 20) &&
  t.columns.every(isColumn) &&
  list(t.rows, 60) &&
  t.rows.every(isRow) &&
  isLayout(t as Table);
// Only text values: other words are dropped, as translations can come from any app (§11).
const texts = (v: unknown) =>
  Object.fromEntries(
    Object.entries(isObj(v) ? v : {}).filter(([, w]) => isStr(w)),
  ) as Record<string, string>;
// §7's rule for settings words: one line of at most 200 characters.
const line = (v: unknown) =>
  isStr(v) && v.trim() && v.length <= 200 && !/[\r\n]/.test(v) ? v : "";
const isColor = (v: unknown): v is string => isStr(v) && COLOR.test(v);
// A locale tag Intl accepts, so number formatting can't throw.
const canonical = (l: unknown) => {
  try {
    return Intl.getCanonicalLocales(l as string)[0] ?? "en";
  } catch {
    return "en";
  }
};

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
  const at = (k: string) =>
    (isObj(d[k]) ? d[k] : {}) as Record<string, unknown>;
  const [units, popup, colors, text, link, place] = [
    "units",
    "popup",
    "colors",
    "text",
    "link",
    "placement",
  ].map(at);
  const font = isObj(popup.font) ? popup.font.fileUrl : "";
  const hex = [colors.text, colors.accent, colors.background];
  const country = isStr(d.country) ? d.country : "";
  const selector = line(place.selector);
  return {
    unit,
    roundTo,
    tables,
    words: { ...texts(words), ...texts(d.strings) },
    sys:
      units.default === "in" || units.default === "cm"
        ? units.default
        : ["US", "LR", "MM"].includes(country)
          ? "in"
          : "cm",
    toggle: units.toggle !== false,
    country,
    locale: canonical(d.locale),
    label: line(text.label),
    header: line(text.header),
    icon: link.icon === "none" ? "none" : "ruler",
    rtl: popup.rtl === true,
    font: isStr(font) && FONT_URL.test(font) ? font : "",
    colors:
      colors.mode === "custom" && hex.every(isColor)
        ? { text: hex[0], accent: hex[1], bg: hex[2] }
        : null,
    css: cssProblem(d.css) ? "" : (d.css as string),
    page: place.productBlock !== false,
    quick: place.quickView === true,
    featured: place.featured === true,
    selector,
    raw: d,
  };
}

// The fit finder a Pro store's chart printed (§10), checked again like the
// tables, or null, which leaves out Find my size.
function fitOf(g: Guide) {
  const { plan, chart } = g.raw as { plan: unknown; chart: { fit?: unknown } };
  const f = chart.fit;
  const table = isObj(f) && g.tables.find((tb) => tb.id === f.table);
  if (plan !== "pro" || !isObj(f) || !table) return null;
  const measure = (c: unknown) =>
    table.columns.some((x) => x.id === c && x.kind === "measure");
  const ok =
    ["none", "some", "high"].includes(f.stretch as string) &&
    isObj(f.ease) &&
    Object.values(f.ease).every((n) => typeof n === "number") &&
    list(f.questions, 6) &&
    f.questions.every(
      (q) =>
        isObj(q) &&
        isId(q.id) &&
        (q.kind === "measure"
          ? measure(q.col)
          : q.kind === "choice"
            ? list(q.options, 20) &&
              q.options.every((o) => isObj(o) && isId(o.id) && list(o.rows, 60))
            : q.kind === "usual_size" || q.kind === "fit"),
    );
  return ok ? { table, fit: f as Fit } : null;
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
const norm = (s: string) => s.trim().toLowerCase();
const SYSTEMS = ["US", "UK", "EU", "AU"];
// The size system most shoppers in a country wear, beyond US and AU. Built on
// use, so loader.js, which bundles this module for parseGuide, drops it.
const systemOf = (country: string) =>
  new Map(
    "GB:UK IE:UK MT:UK CY:UK GG:UK JE:UK IM:UK GI:UK ZA:UK NZ:AU CA:US CH:EU NO:EU IS:EU LI:EU AT:EU BE:EU BG:EU CZ:EU DE:EU DK:EU EE:EU ES:EU FI:EU FR:EU GR:EU HR:EU HU:EU IT:EU LT:EU LU:EU LV:EU NL:EU PL:EU PT:EU RO:EU SE:EU SI:EU SK:EU"
      .split(" ")
      .map((p) => p.split(":") as [string, string]),
  ).get(country) ?? country;
const FORM = 'form[action*="/cart/add"]';

/**
 * Tells Fitted what the shopper did in the guide (ARCHITECTURE §12): the type,
 * the chart and product ids the block's snippet printed, and a fit result's
 * size row id, never anything about the shopper. Sent once, never retried,
 * and not at all without those ids, as in the admin preview.
 */
function track(root: HTMLElement, type: string, size?: string) {
  const ids = root.closest<HTMLElement>(".fitted-guide")?.dataset;
  if (!ids?.chart || !ids.product) return;
  const { chart, product } = ids;
  try {
    const id = crypto.randomUUID();
    const event = JSON.stringify({ id, type, chart, product, size });
    navigator.sendBeacon("/apps/fitted/events", event);
  } catch {
    // A browser without sendBeacon or randomUUID sends nothing.
  }
}

/**
 * Draws the Size chart tab into root, whose data-t-* attributes hold the
 * extension's words. Returns sync, which records the open and picks the size
 * the theme's product form has selected; the loader calls it on every later
 * open.
 */
export function render(root: HTMLElement, g: Guide) {
  // Before the loader's styles, whose merchant CSS must win ties with these.
  if (!document.getElementById("fitted-table-css")) {
    const style = h("style", { id: "fitted-table-css" }, tableCss);
    const loader = document.getElementById("fitted-css");
    if (loader) loader.before(style);
    else document.head.append(style);
  }
  const t = (k: string) =>
    root.dataset[`t${k[0].toUpperCase()}${k.slice(1)}`] ?? "";
  // An extension word with {size} in it, split around the size.
  const around = (k: string, size: Node | string) => {
    const [a, b = ""] = t(k).split("{size}");
    return [a, size, b];
  };
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
  const systems = (tb: Grid): string[] => [
    ...new Set(
      tb.columns.flatMap((c) => (c.kind === "country" ? [c.country] : [])),
    ),
  ];
  // A table whose country columns name two or more systems shows one at a
  // time; the switch offers every system such tables name.
  const regions = SYSTEMS.filter((r) =>
    g.tables.some((tb) => systems(tb).length > 1 && systems(tb).includes(r)),
  );
  const toggle =
    g.toggle &&
    g.tables.some((tb) =>
      tb.columns.some((c) => c.kind === "measure" && c.convert),
    );
  let region = regions.includes(systemOf(g.country))
    ? systemOf(g.country)
    : (g.tables.map(systems).find((s) => s.length > 1)?.[0] ?? "");
  let sys = g.sys;
  let pick = ""; // the picked size, as a key of labels
  const labels = new Map<string, string>(); // size key to its label as written
  const across = new Map<Element, string[]>(); // cells merged across rows: their sizes

  const table = (tb: Grid): Kid[] => {
    const own = systems(tb);
    const only = own.length < 2 ? "" : own.includes(region) ? region : own[0];
    const cols = tb.columns.flatMap((c, j) =>
      c.kind === "country" && only && c.country !== only ? [] : [{ c, j }],
    );
    const wrap = (c: Column) =>
      tb.wrap?.includes(c.id) ? "fitted-wrap" : undefined;
    const keys = tb.rows.map((r) =>
      word(`${tb.id}.${r.id}.${tb.columns[0].id}`),
    );
    // Cells a merge covers are left out, except its first shown cell, which
    // holds the merge's top-left cell across the shown columns it spans.
    const spans = new Map<string, { c: number; rows: number; cols: number }>();
    const covered = new Set<string>();
    for (const m of tb.merges ?? []) {
      const r = tb.rows.findIndex((x) => x.id === m.row);
      const c = tb.columns.findIndex((x) => x.id === m.col);
      for (let i = r; i < r + m.rows; i++) {
        if (c === 0) keys[i] = keys[r];
        for (let j = c; j < c + m.cols; j++) covered.add(`${i},${j}`);
      }
      const inside = cols.filter(({ j }) => j >= c && j < c + m.cols);
      if (inside.length)
        spans.set(`${r},${inside[0].j}`, {
          c,
          rows: m.rows,
          cols: inside.length,
        });
    }
    const cell = (i: number, c: Column, j: number) => {
      const row = tb.rows[i];
      if (j === 0) {
        const label = keys[i];
        return h(
          "th",
          { scope: "row", class: wrap(c) },
          norm(label) &&
            h(
              "button",
              {
                type: "button",
                class: "fitted-pick",
                "aria-pressed": "false",
                "aria-label": around("choose", label).join(""),
              },
              label,
            ),
        );
      }
      if (c.kind !== "measure")
        return h("td", { class: wrap(c) }, word(`${tb.id}.${row.id}.${c.id}`));
      const from = c.unit ?? g.unit;
      const to = shown(from, c.convert, sys);
      const nums = row.cells[c.id]?.map((n) => number(n, from, to));
      return h("td", { class: wrap(c) }, nums?.join("–"));
    };
    const head = cols.map(({ c }) => {
      let text = word(`${tb.id}.${c.id}`);
      if (c.kind === "country") text ||= c.country;
      const u = c.kind === "measure" && shown(c.unit ?? g.unit, c.convert, sys);
      // With the toggle showing, the unit it names goes unsaid in headers.
      if (u && !(toggle && u === sys))
        text = [text, `(${t(u)})`].filter(Boolean).join(" ");
      return h("th", { scope: "col", class: wrap(c) }, text);
    });
    const rows = tb.rows.map((_, i) => {
      const key = norm(keys[i]);
      if (key && !labels.has(key)) labels.set(key, keys[i].trim());
      const tds = cols.map(({ c, j }) => {
        const span = spans.get(`${i},${j}`);
        if (!span) return !covered.has(`${i},${j}`) && cell(i, c, j);
        const el = cell(i, tb.columns[span.c], span.c);
        el.setAttribute("rowspan", `${span.rows}`);
        el.setAttribute("colspan", `${span.cols}`);
        across.set(el, keys.slice(i, i + span.rows).map(norm));
        return el;
      });
      return h("tr", { "data-fitted-size": key || undefined }, ...tds);
    });
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
          h("caption", { class: "fitted-sr" }, title || t("chart")),
          h("thead", {}, h("tr", {}, ...head)),
          h("tbody", {}, ...rows),
        ),
      ),
      note(`${tb.id}.note`),
    ];
  };

  // The theme's size controls: radios and selects around the product form
  // nearest the block, never past its section, skipping variant ids,
  // quantities and the guide's own fields. Read fresh each time, as themes
  // redraw them.
  const controls = () => {
    const block = root.closest(".fitted-guide");
    const end = block?.closest(".shopify-section");
    let p = block?.parentElement;
    while (p && !p.querySelector(FORM)) p = p === end ? null : p.parentElement;
    const els = p?.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "input[type=radio], select",
    );
    return [...(els ?? [])].filter(
      (el) =>
        !el.disabled &&
        el.name !== "id" &&
        el.name !== "quantity" &&
        !el.closest(".fitted-guide"),
    );
  };
  const option = (el: HTMLSelectElement, size: string) =>
    [...el.options].find((o) => !o.disabled && norm(o.value) === size);
  const offer = (size: string) =>
    controls().find((el) =>
      "options" in el ? option(el, size) : norm(el.value) === size,
    );
  const current = () =>
    controls()
      .map((el) => ("options" in el || el.checked ? norm(el.value) : ""))
      .find((v) => labels.has(v)) ?? "";

  const said = h("strong");
  const go = h("button", {
    type: "button",
    class: "fitted-btn",
    "data-fitted-select": "",
  });
  const foot = h("div", { class: "fitted-foot" }, said, go);
  const part = h("div", { class: "fitted-part" });
  // Lights up every row of the size, in every table, and fills the footer.
  const choose = (size: string) => {
    pick = labels.has(size) ? size : "";
    part.querySelectorAll<HTMLElement>("tr[data-fitted-size]").forEach((tr) => {
      const on = tr.dataset.fittedSize === pick;
      tr.classList.toggle("fitted-on", on);
      tr.querySelector(".fitted-pick")?.setAttribute("aria-pressed", `${on}`);
    });
    across.forEach((ks, el) =>
      el.classList.toggle("fitted-lit", !!pick && ks.includes(pick)),
    );
    const label = labels.get(pick) ?? "";
    foot.hidden = !pick;
    said.replaceChildren(...around("selected", h("span", {}, label)));
    go.textContent = around("select", label).join("");
    go.hidden = !pick || !offer(pick);
  };
  // Sets the picked size in the theme's form the way a shopper would, so the
  // theme updates its price and button, then closes the guide.
  const apply = () => {
    const el = offer(pick);
    root.closest("dialog")?.close();
    if (el && "options" in el) {
      el.value = option(el, pick)?.value ?? el.value;
      for (const type of ["input", "change"])
        el.dispatchEvent(new Event(type, { bubbles: true }));
    } else if (el && !el.checked) el.click();
  };
  const draw = () => {
    across.clear();
    const kids = [...g.tables.flatMap(table), note("tips")];
    part.replaceChildren(...kids.filter((k): k is Node => !!k));
    choose(pick);
  };
  const seg = (
    name: string,
    key: string,
    vals: string[],
    on: string,
    say = (v: string) => v,
    look = "fitted-seg",
  ) =>
    h(
      "div",
      { role: "group", "aria-label": t(name), class: look },
      ...vals.map((v) =>
        h(
          "button",
          { type: "button", [`data-${key}`]: v, "aria-pressed": `${v === on}` },
          say(v),
        ),
      ),
    );
  const bar =
    (regions.length > 0 || toggle) &&
    h(
      "div",
      { class: "fitted-bar" },
      regions.length > 0 && seg("system", "fitted-region", regions, region),
      toggle && seg("units", "fitted-sys", ["in", "cm"], sys, t),
    );

  // Find my size (§10): the chart's questions, then, once each one a shopper
  // can't skip has an answer, findSize's pick and why. Answers never leave
  // the browser: no request carries one, and only sessionStorage keeps them,
  // so the next product with this chart starts from them.
  function fitTab() {
    const found = fitOf(g);
    if (!found) return null;
    const { table: ft, fit } = found;
    const qs = fit.questions;
    const measured = qs.flatMap((q) => (q.kind === "measure" ? [q] : []));
    const key = isStr(g.raw.handle) && `fitted:answers:${g.raw.handle}`;
    const size = (row: string) => word(`${ft.id}.${row}.${ft.columns[0].id}`);
    const label = (c: string) => word(`${ft.id}.${c}`);
    const col = (c: string) => ft.columns.find((x) => x.id === c) as Measure;
    const lower = (s: string) => s.toLocaleLowerCase(g.locale);
    // An extension word with its {name}s filled in.
    const fill = (k: string, v: Record<string, string>) =>
      t(k).replace(/\{(\w+)\}/g, (_, n: string) => v[n] ?? "");
    const comma = nf.formatToParts(0.5).some((p) => p.value === ",");
    // A measurement as typed, like "35.5", "35,5 cm" or "90cm": in the unit
    // it names, else the units the guide shows. Leaving the field writes it
    // out, so the shopper sees which unit Fitted read.
    const kinds = (c: Measure): Unit[] =>
      ["in", "cm"].includes(c.unit ?? g.unit) ? ["in", "cm"] : ["lb", "kg"];
    const typed = (text: string, c: Measure) => {
      const m = /^\s*(\d+(?:[.,]\d+)?)\s*(.*)$/.exec(text);
      const value = Number(m?.[1].replace(",", "."));
      if (!m || !isNum(value)) return undefined;
      const unit = kinds(c).find((u) => [u, norm(t(u))].includes(norm(m[2])));
      return { value, unit: unit ?? shown(c.unit ?? g.unit, c.convert, sys) };
    };
    const written = (m: { value: number; unit: Unit }) =>
      `${String(m.value).replace(".", comma ? "," : ".")} ${t(m.unit)}`;

    // With every measurement skippable, the usual size stands in.
    const names = measured.map((m) => lower(label(m.col)));
    const hint =
      names.length > 0 &&
      measured.every((m) => m.optional) &&
      fill("no_tape", { measure: new Intl.ListFormat(g.locale).format(names) });
    const form = h("form", { class: "fitted-fit" });
    for (const q of qs) {
      const words = word(`fit.${q.id}`);
      const opts =
        q.kind === "fit"
          ? ["snug", "regular", "relaxed"].map((v) => [v, t(v)])
          : q.kind === "choice"
            ? q.options.map((o) => [o.id, word(`fit.${q.id}.${o.id}`)])
            : null;
      const one = (v: string, w: string) =>
        h(
          "label",
          { class: "fitted-opt" },
          h("input", { type: "radio", name: q.id, value: v, "data-q": q.id }),
          w,
        );
      form.append(
        opts
          ? h(
              "fieldset",
              {},
              h("legend", {}, words),
              ...opts.map(([v, w]) => one(v, w)),
            )
          : h(
              "label",
              {},
              q.kind === "measure" && q.optional
                ? fill("optional", { question: words })
                : words,
              q.kind === "measure"
                ? h("input", {
                    type: "text",
                    inputmode: "decimal",
                    autocomplete: "off",
                    "data-q": q.id,
                  })
                : h(
                    "select",
                    { "data-q": q.id },
                    h("option", { value: "" }),
                    ...ft.rows.map((r) =>
                      h("option", { value: r.id }, size(r.id)),
                    ),
                  ),
            ),
      );
      if (q.kind === "usual_size" && hint)
        form.append(h("p", { class: "fitted-fine" }, hint));
    }
    const out = h("div", { class: "fitted-result" });
    const status = h("p", { class: "fitted-sr", role: "status" });
    form.append(out, status);
    const fields = (q: Question) => [
      ...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        `[data-q="${q.id}"]`,
      ),
    ];
    const read = () => {
      const a: Answers = {};
      for (const q of qs) {
        const el = fields(q).find(
          (x) => x.type !== "radio" || (x as HTMLInputElement).checked,
        );
        if (el?.value)
          a[q.id] =
            q.kind === "measure" ? typed(el.value, col(q.col)) : el.value;
      }
      return a;
    };
    // What another product with this chart left, back in the fields.
    try {
      const old: unknown = JSON.parse(
        (key && sessionStorage.getItem(key)) || "{}",
      );
      for (const q of isObj(old) ? qs : []) {
        const a = (old as Record<string, unknown>)[q.id];
        for (const el of fields(q))
          if (q.kind === "measure")
            el.value =
              isObj(a) &&
              isNum(a.value) &&
              kinds(col(q.col)).includes(a.unit as Unit)
                ? written(a as { value: number; unit: Unit })
                : "";
          else if (el.type === "radio")
            (el as HTMLInputElement).checked = el.value === a;
          else el.value = isStr(a) ? a : "";
      }
    } catch {
      // No storage, or nothing readable there: the fields start empty.
    }

    // Why findSize picked what it did, in the extension's words.
    const why = ({ reason: { key: k, values: v } }: FitResult) => {
      const [, , base, moved] = k.split(".");
      const s = (n: string) => (v[n] === undefined ? "" : size(`${v[n]}`));
      const c = v.col === undefined ? null : col(`${v.col}`);
      let m = "";
      let stretch = "";
      if (c) {
        const own = c.unit ?? g.unit;
        const unit = v.unit as Unit;
        const ease = fit.ease[c.id];
        const cell = ft.rows.find((r) => r.id === v[moved ? "from" : "size"])
          ?.cells[c.id];
        const at = convert(+v.value, unit, own);
        // Past the size's own top value, only the stretch held it (§10).
        if (
          base === "in" &&
          cell &&
          at !== null &&
          at + (ease || 0) > cell[cell.length - 1]
        )
          stretch = t("stretched");
        const eased = `${number(ease, own, unit)} ${t(unit)}`;
        m = fill("measured", {
          value: nf.format(+v.value),
          unit: t(unit),
          col: lower(label(c.id)),
          ease: ease ? fill("eased", { ease: eased }) : "",
        });
      }
      return base === "none"
        ? ""
        : fill(`why_${base}`, {
            m,
            stretch,
            size: s(moved ? "from" : "size"),
            below: s("below"),
            above: s("above"),
            fit: v.fit ? fill("liked", { fit: lower(t(`${v.fit}`)) }) : "",
            so: moved ? fill("so", { size: s("size") }) : "",
          });
    };
    const show = (r: FitResult | null) => {
      out.hidden = !r;
      const text = isObj(g.raw.text) ? line(g.raw.text.noFit) : "";
      const said = r && why(r);
      const head =
        r?.row === null
          ? [text || t("no_fit")]
          : around("recommend", h("span", {}, size(r?.row ?? "")));
      out.replaceChildren(
        ...(r ? [h("h3", { class: "fitted-h3" }, ...head)] : []),
        ...(said ? [h("p", { class: "fitted-note" }, said)] : []),
      );
      status.textContent = [...out.children]
        .map((k) => k.textContent)
        .join(" ");
    };
    let sent: string | undefined; // the last result Fitted was told
    // tell is false for the answers the guide opens with, which the shopper
    // didn't give on this page.
    const update = (tell = true) => {
      const a = read();
      try {
        if (key) sessionStorage.setItem(key, JSON.stringify(a));
      } catch {
        // No storage: the answers last until the page goes.
      }
      // Every answer a shopper can't skip, and one besides a fit to go on
      // when the finder asks one.
      const other = qs.filter((q) => q.kind !== "fit");
      const ready =
        (!other.length || other.some((q) => a[q.id] !== undefined)) &&
        qs.every(
          (q) => (q.kind === "measure" && q.optional) || a[q.id] !== undefined,
        );
      const r = ready
        ? findSize({ unit: g.unit, tables: g.tables, fit }, a)
        : null;
      // A result unlike the last one told.
      if (tell && r && (r.row ?? "") !== sent) {
        sent = r.row ?? "";
        track(root, "fit_result", r.row ?? undefined);
      }
      show(r);
    };
    // The result follows a field the shopper leaves, a pick, or Enter, which
    // never submits. No submit, input or change reaches a theme's form around
    // the guide.
    const settle = (el: HTMLInputElement) => {
      const q = measured.find((x) => x.id === el.dataset.q);
      const m = q && typed(el.value, col(q.col));
      if (m) el.value = written(m);
      update();
    };
    for (const type of ["submit", "input", "change"])
      form.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === "submit") e.preventDefault();
        if (type === "change") settle(e.target as HTMLInputElement);
      });
    form.addEventListener("keydown", (e) => {
      const el = e.target as HTMLInputElement;
      if (e.key !== "Enter" || el.type !== "text") return;
      e.preventDefault();
      settle(el);
    });
    update(false);
    form.hidden = true;
    return form;
  }

  // Switches redraw only the tables, so focus stays on the switch pressed.
  root.addEventListener("click", (e) => {
    const hit = (sel: string) => {
      const el = (e.target as Element).closest<HTMLElement>(sel);
      return el && root.contains(el) ? el : null;
    };
    const opt = hit(
      "[data-fitted-region], [data-fitted-sys], [data-fitted-tab]",
    );
    if (opt) {
      region = opt.dataset.fittedRegion ?? region;
      sys = (opt.dataset.fittedSys as Sys | undefined) ?? sys;
      opt.parentElement
        ?.querySelectorAll("button")
        .forEach((b) => b.setAttribute("aria-pressed", `${b === opt}`));
      chart.hidden = opt.dataset.fittedTab === "fit";
      if (finder) finder.hidden = !chart.hidden;
      draw();
    } else if (hit("[data-fitted-select]")) apply();
    else {
      const tr = hit("tr[data-fitted-size]");
      if (tr?.dataset.fittedSize) choose(tr.dataset.fittedSize);
    }
  });
  // With Find my size, tabs: the Size chart's parts, or Find my size.
  const chart = h("div", { class: "fitted-part" }, bar, part, foot);
  const finder = fitTab();
  const tabs =
    finder &&
    seg("sections", "fitted-tab", ["chart", "fit"], "chart", t, "fitted-tabs");
  root.replaceChildren(...[tabs, chart, finder].filter((k) => !!k));
  draw();
  const sync = () => {
    track(root, "open");
    choose(current() || pick);
  };
  sync();
  return sync;
}
