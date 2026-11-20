// The FitFinder board's chart half (ARCHITECTURE §10): a chart's questions,
// ease, rules and sample result in the canvas's words.
import {
  type Answers,
  type Fit,
  type FitResult,
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

// A chart's fit, or a new one on its first table with measurements (§10).
export const fitOf = (c: { tables: Table[]; fit?: Fit }): Fit =>
  c.fit ?? {
    table: (
      c.tables.find((t) => t.columns.some((x) => x.kind === "measure")) ??
      c.tables[0]
    ).id,
    questions: [],
    ease: {},
    stretch: "none",
  };
// The words of a chart's questions, or with `fit` false all its others.
export const fitWords = (w: Record<string, string>, fit = true) =>
  Object.fromEntries(
    Object.entries(w).filter(([k]) => k.startsWith("fit.") === fit),
  );

const label = (c: FitChart, col: string) =>
  c.words[`${c.table.id}.${col}`] || col;
export const size = (c: FitChart, row: string) =>
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
  return { words: words(c, q), kind };
}

const words = (c: FitChart, q: Question) => c.words[`fit.${q.id}`] || q.id;
const and = (parts: string[]) =>
  parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
    : parts.join("");

// "How Fitted picks a size": findSize's rules (§10) for this chart's questions.
export function howItPicks(c: FitChart) {
  const qs = c.fit.questions;
  const cols = [
    ...new Set(
      qs.flatMap((q) =>
        q.kind === "measure" ? [label(c, q.col).toLowerCase()] : [],
      ),
    ),
  ];
  const usual = qs.some((q) => q.kind === "usual_size");
  const lines = qs.flatMap((q) =>
    q.kind === "choice"
      ? [`Shoppers who answer "${words(c, q)}" only get that answer's sizes.`]
      : [],
  );
  if (cols.length === 1)
    lines.push(
      `Match the shopper's ${cols[0]} measurement to the ${c.name} chart.`,
    );
  else if (cols.length)
    lines.push(
      `Match the shopper's ${and(cols)} measurements to the ${c.name} chart. The largest size wins.`,
    );
  else if (usual) lines.push("Start from the size they usually wear.");
  // A one-size chart names its size once.
  const ends = [...new Set([c.table.rows[0], c.table.rows.at(-1)!])];
  if (qs.some((q) => q.kind === "fit"))
    lines.push(
      `Between two sizes, pick the larger one, or the smaller for a snug fit. Otherwise, relaxed fit moves one size up and snug fit one size down, never past ${ends.map((r) => size(c, r.id)).join(" or ")}.`,
    );
  if (cols.length && usual)
    lines.push("No measurement? Start from the size they usually wear.");
  return lines;
}

// The preview's shopper: the middle size's measurements, that size as the
// usual one, a regular fit, and the first answer that keeps that size.
export function sampleAnswers(c: FitChart): Answers {
  const { rows, columns } = c.table;
  const mid = rows[Math.floor((rows.length - 1) / 2)];
  const answers: Answers = {};
  for (const q of c.fit.questions) {
    if (q.kind === "measure") {
      const col = columns.find((x) => x.id === q.col);
      const cell = mid.cells[q.col];
      if (col?.kind !== "measure" || !cell) continue;
      const value = Math.round((cell[0] + (cell[1] ?? cell[0])) * 5) / 10;
      answers[q.id] = { value, unit: col.unit ?? c.unit };
    } else if (q.kind === "usual_size") answers[q.id] = mid.id;
    else if (q.kind === "fit") answers[q.id] = "regular";
    else
      answers[q.id] = (
        q.options.find((o) => o.rows.includes(mid.id)) ?? q.options[0]
      )?.id;
  }
  return answers;
}

// The last question and its answers as the preview draws them, the sample's marked.
export function lastStep(c: FitChart, answers: Answers) {
  const q = c.fit.questions.at(-1)!;
  const a = answers[q.id];
  const options =
    q.kind === "measure"
      ? typeof a === "object"
        ? [{ label: `${a.value} ${a.unit}`, on: true }]
        : []
      : q.kind === "fit"
        ? ["Snug", "Regular", "Relaxed"].map((o) => ({
            label: o,
            on: o.toLowerCase() === a,
          }))
        : q.kind === "usual_size"
          ? c.table.rows.map((r) => ({ label: size(c, r.id), on: r.id === a }))
          : q.options.map((o) => ({
              label: c.words[`fit.${q.id}.${o.id}`] || o.id,
              on: o.id === a,
            }));
  return { words: words(c, q), options };
}

// Why findSize picked what it did, as the shopper reads it, naming the ease
// in `c.fit` it added to the measurement. The sample always likes a regular
// fit, so the fit-moved reasons never show here.
export function reasonText(c: FitChart, { reason }: FitResult) {
  const v = reason.values;
  const s = (k: string) => size(c, String(v[k]));
  const col = String(v.col);
  const ease = c.fit.ease[col];
  const unit = measures(c).find((m) => m.id === col)?.unit;
  const m = `Your ${v.value} ${v.unit} ${label(c, col).toLowerCase()}${ease ? ` with ${round2(ease)} ${unit} of ease` : ""}`;
  const fit = v.fit ? `, and you like a ${v.fit} fit` : "";
  // Past the size's own top value, only the stretch held it (§10).
  const cell = c.table.rows.find((r) => r.id === v.size)?.cells[col];
  const at = unit && convert(Number(v.value), v.unit as Unit, unit);
  const stretched =
    cell && at != null && at + (ease || 0) > (cell[1] ?? cell[0])
      ? ", counting the fabric's stretch"
      : "";
  const text: Record<string, () => string> = {
    in: () => `${m} falls in ${s("size")} on this chart${stretched}${fit}.`,
    between: () =>
      `${m} falls between ${s("below")} and ${s("above")} on this chart${fit}, so ${s("size")}.`,
    large: () => `${m} is past ${s("size")}, the largest size on this chart.`,
    small: () => `${m} is below ${s("size")}, the smallest size on this chart.`,
    usual: () => `You usually wear ${s("size")}${fit}.`,
    choice: () => `Your answers leave only ${s("size")} on this chart.`,
  };
  return text[reason.key.replace("fit.reason.", "")]?.() ?? "";
}
