// CSV of size charts in Fitted's own layout, which ARCHITECTURE §13 records.
// Export writes every part of a chart, so importing the file (the next CSV
// steps) can bring it back unchanged.
import type { ChartInput, Column } from "./chart.server";

const MARK = "Fitted size charts";
// Spreadsheets run a cell starting with one of these as a formula. Export puts
// an apostrophe in front, even when apostrophes already lead, so import can
// take one off and get the text back exactly.
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
  const add = (...cells: string[]) => out.push(cells);
  for (const { name, chart } of charts) {
    if (!chart) {
      // Never dropped silently (§5): named, and importing says why it's empty.
      add("Chart", name);
      add("Error", "This chart has errors in Fitted");
      continue;
    }
    const c = chart.content;
    const used = new Set<string>();
    const word = (key: string) => (used.add(key), c.words[key] ?? "");
    add("Chart", chart.name, chart.template, c.unit, `${c.roundTo}`);
    const { measure, videoUrl, fit } = c;
    add("Settings", JSON.stringify({ measure, videoUrl, fit }));
    for (const t of c.tables) {
      const { id, columns: cols } = t;
      add(
        "Table",
        id,
        ...["title", "sub", "note"].map((k) => word(`${id}.${k}`)),
      );
      add("Columns", "", ...cols.map((k) => `${k.id}:${typeOf(k)}`));
      add("Labels", "", ...cols.map((k) => word(`${id}.${k.id}`)));
      for (const r of t.rows) {
        const cell = (k: Column) =>
          k.kind === "measure"
            ? (r.cells[k.id]?.join("–") ?? "")
            : word(`${id}.${r.id}.${k.id}`);
        add("Row", r.id, ...cols.map(cell));
      }
      for (const m of t.merges ?? [])
        add("Merge", m.row, m.col, `${m.rows}`, `${m.cols}`);
      if (t.wrap?.length) add("Wrap", ...t.wrap);
    }
    for (const [key, text] of Object.entries(c.words))
      if (!used.has(key)) add("Text", key, text);
  }
  // The BOM makes Excel read the file as UTF-8.
  return `\uFEFF${out.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
