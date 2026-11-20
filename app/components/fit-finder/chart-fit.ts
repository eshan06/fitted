// The FitFinder board's chart half (ARCHITECTURE §10): a chart's questions
// and ease in the canvas's words.
import {
  type Fit,
  type Question,
  type Table,
  type Unit,
  convert,
} from "../../lib/fit-finder";

// A chart with `content.fit`: its fit table and only the words this screen shows.
export type FitChart = {
  id: string;
  updatedAt: string;
  name: string;
  unit: "in" | "cm";
  table: Table;
  fit: Fit;
  words: Record<string, string>;
};

const label = (c: FitChart, col: string) =>
  c.words[`${c.table.id}.${col}`] || col;
const size = (c: FitChart, row: string) =>
  c.words[`${c.table.id}.${row}.${c.table.columns[0].id}`] || row;
const measures = (c: FitChart) =>
  c.table.columns.flatMap((col) =>
    col.kind === "measure" ? [{ id: col.id, unit: col.unit ?? c.unit }] : [],
  );
const round2 = (n: number) => Math.round(n * 100) / 100;

// "+2 in at bust", one part per column, as the merchant types it.
export const formatEase = (c: FitChart) =>
  measures(c)
    .filter((m) => Number.isFinite(c.fit.ease[m.id]))
    .map((m) => {
      const n = c.fit.ease[m.id];
      return `${n >= 0 ? "+" : ""}${round2(n)} ${m.unit} at ${label(c, m.id).toLowerCase()}`;
    })
    .join(", ");

const EASE =
  /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(in|cm|lb|kg)?(?:\s+at\s+(.+))?$/i;
// Parts split by commas, each a number, a unit (the column's when left out)
// and "at <measurement>" (every measurement when left out). Null when a part
// doesn't read.
export function parseEase(c: FitChart, text: string) {
  const ease: Record<string, number> = {};
  for (const part of text.split(",").map((p) => p.trim())) {
    if (!part) continue;
    const m = EASE.exec(part);
    if (!m) return null;
    const name = m[3]?.trim().toLowerCase();
    let hit = false;
    for (const col of measures(c)) {
      if (name && label(c, col.id).toLowerCase() !== name) continue;
      const from = (m[2]?.toLowerCase() ?? col.unit) as Unit;
      const v = convert(Number(m[1]), from, col.unit);
      if (v === null) continue; // a weight under "+2 in" when no measurement is named
      if (Math.abs(v) >= 10000) return null;
      ease[col.id] = round2(v);
      hit = true;
    }
    if (!hit) return null;
  }
  return ease;
}

// A question's words and what kind it is, as the questions list shows them.
export function describe(c: FitChart, q: Question) {
  const { rows } = c.table;
  const kind =
    q.kind === "measure"
      ? `Number${q.optional ? ", optional" : ""}. Links to How to measure.`
      : q.kind === "usual_size"
        ? `Choice: ${size(c, rows[0].id)} to ${size(c, rows.at(-1)!.id)}.${c.fit.questions.some((x) => x.kind === "measure") ? " Used when there's no measurement." : ""}`
        : q.kind === "fit"
          ? "Choice: Snug, Regular, Relaxed"
          : `Choice: ${q.options.map((o) => c.words[`fit.${q.id}.${o.id}`] || o.id).join(", ")}`;
  return { words: c.words[`fit.${q.id}`] || q.id, kind };
}
