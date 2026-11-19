// The fit finder engine (ARCHITECTURE §10). The size guide and the admin
// preview share it, so it stays pure and imports nothing.

export type Unit = "in" | "cm" | "lb" | "kg";
export type Column =
  | { id: string; kind: "size" | "text" }
  | { id: string; kind: "country"; country: "US" | "UK" | "EU" | "AU" }
  | { id: string; kind: "measure"; unit?: Unit; convert: boolean };
export type Table = {
  id: string;
  columns: Column[];
  rows: { id: string; cells: Record<string, [number] | [number, number]> }[];
};
export type Question =
  | { id: string; kind: "measure"; col: string; optional: boolean }
  | { id: string; kind: "usual_size" }
  | { id: string; kind: "fit" }
  | { id: string; kind: "choice"; options: { id: string; rows: string[] }[] };
export type Fit = {
  table: string;
  questions: Question[];
  ease: Record<string, number>;
  stretch: "none" | "some" | "high";
};
export type Chart = { unit: "in" | "cm"; tables: Table[]; fit: Fit };

// By question id: a measure answer is a number with the unit the shopper typed
// in; usual_size is a row id; fit is snug, regular or relaxed; choice is an
// option id.
export type Answers = Record<
  string,
  { value: number; unit: Unit } | string | undefined
>;
export type Reason = { key: string; values: Record<string, string | number> };
export type FitResult = {
  row: string | null;
  reason: Reason;
  bars: { row: string; cols: Record<string, number> }[]; // 0 tight, 50 just right, 100 loose
};

// ponytail: calibration knob, how far past a row's top value a stretchy
// garment still fits. Tune it from returns data once Pro stores report it.
export const STRETCH = { none: 0, some: 0.03, high: 0.06 };

const PER_BASE: Record<Unit, number> = { in: 2.54, cm: 1, lb: 0.4536, kg: 1 };
const isLength = (u: Unit) => u === "in" || u === "cm";

function convert(value: number, from: Unit, to: Unit): number | null {
  if (!Object.hasOwn(PER_BASE, from) || !Object.hasOwn(PER_BASE, to)) {
    return null;
  }
  if (isLength(from) !== isLength(to)) return null;
  return (value * PER_BASE[from]) / PER_BASE[to];
}

type Range = [number, number] | null;
type Measure = {
  col: string;
  value: number;
  unit: Unit;
  t: number; // the shopper's value in the column's unit, plus ease
  ranges: Range[]; // one per candidate row, stretch applied
};
type Placed =
  | { at: "in" | "small" | "large"; i: number } // off the chart, i is the nearest row
  | { at: "between"; lo: number; hi: number };

function place(ranges: Range[], t: number): Placed {
  const i = ranges.findIndex((r) => r !== null && r[0] <= t && t <= r[1]);
  if (i >= 0) return { at: "in", i };
  let lo = -1;
  let hi = -1;
  ranges.forEach((r, j) => {
    if (!r) return;
    if (r[1] < t && (lo < 0 || r[1] > ranges[lo]![1])) lo = j;
    if (r[0] > t && (hi < 0 || r[0] < ranges[hi]![0])) hi = j;
  });
  if (lo < 0) return { at: "small", i: hi };
  if (hi < 0) return { at: "large", i: lo };
  return { at: "between", lo, hi };
}

// One size looser is 75, two is 100; a size's step is the average gap between
// neighbouring sizes' midpoints.
function fitBars(rows: Table["rows"], measures: Measure[]) {
  const out = rows.map((r) => ({
    row: r.id,
    cols: {} as Record<string, number>,
  }));
  for (const m of measures) {
    const mids = m.ranges.flatMap((r) => (r ? [(r[0] + r[1]) / 2] : []));
    let step = 0;
    for (let k = 1; k < mids.length; k++)
      step += Math.abs(mids[k] - mids[k - 1]);
    step = step > 0 ? step / (mids.length - 1) : mids[0] * 0.05;
    m.ranges.forEach((r, j) => {
      if (!r) return;
      const loose = 50 + (25 * ((r[0] + r[1]) / 2 - m.t)) / step;
      out[j].cols[m.col] = Math.min(100, Math.max(0, Math.round(loose)));
    });
  }
  return out;
}

export function findSize(chart: Chart, answers: Answers): FitResult {
  const { fit } = chart;
  const table = chart.tables.find((t) => t.id === fit.table);
  const none = (bars: FitResult["bars"]): FitResult => ({
    row: null,
    reason: { key: "fit.reason.none", values: {} },
    bars,
  });
  if (!table) return none([]);

  let rows = table.rows;
  let narrowed = false;
  let pref: "snug" | "regular" | "relaxed" | undefined;
  let usual: string | undefined;
  for (const q of fit.questions) {
    const a = answers[q.id];
    if (typeof a !== "string") continue;
    if (q.kind === "choice") {
      const option = q.options.find((o) => o.id === a);
      if (option) {
        rows = rows.filter((r) => option.rows.includes(r.id));
        narrowed = true;
      }
    } else if (q.kind === "fit" && ["snug", "regular", "relaxed"].includes(a)) {
      pref = a as typeof pref;
    } else if (q.kind === "usual_size") {
      usual = a;
    }
  }

  const stretch = STRETCH[fit.stretch] ?? 0;
  const measures: Measure[] = [];
  for (const q of fit.questions) {
    const a = answers[q.id];
    if (q.kind !== "measure" || !a || typeof a !== "object") continue;
    const col = table.columns.find((c) => c.id === q.col);
    if (col?.kind !== "measure") continue;
    if (!Number.isFinite(a.value) || a.value <= 0 || a.value >= 10000) continue;
    const v = convert(a.value, a.unit, col.unit ?? chart.unit);
    if (v === null) continue;
    const ease = fit.ease[col.id];
    const give = isLength(col.unit ?? chart.unit) ? 1 + stretch : 1; // fabric stretches, weight doesn't
    const ranges: Range[] = rows.map((r) => {
      const c = r.cells[col.id];
      return c ? [c[0], (c[1] ?? c[0]) * give] : null;
    });
    if (!ranges.some(Boolean)) continue;
    const t = v + (Number.isFinite(ease) ? ease : 0);
    measures.push({ col: col.id, value: a.value, unit: a.unit, t, ranges });
  }

  const bars = fitBars(rows, measures);
  const id = (i: number) => rows[i].id;
  const result = (
    row: number | null,
    key: string,
    values: Reason["values"],
  ) => ({
    row: row === null ? null : id(row),
    reason: {
      key: `fit.reason.${key}`,
      values: pref ? { ...values, fit: pref } : values,
    },
    bars,
  });
  // Snug moves one size down and relaxed one up, never past either end.
  const shifted = (key: string, at: number, values: Reason["values"]) => {
    const to = at + (pref === "relaxed" ? 1 : pref === "snug" ? -1 : 0);
    if (to === at || to < 0 || to >= rows.length) {
      return result(at, key, { ...values, size: id(at) });
    }
    const dir = to > at ? "up" : "down";
    return result(to, `${key}.${dir}`, {
      ...values,
      from: id(at),
      size: id(to),
    });
  };

  if (measures.length) {
    const placed = measures.map((m) => ({ m, p: place(m.ranges, m.t) }));
    const said = (m: Measure) => ({ col: m.col, value: m.value, unit: m.unit });
    // A garment has to fit the largest measurement, so any measurement past
    // the largest size means nothing on this chart fits.
    for (const { m, p } of placed) {
      if (p.at === "large")
        return result(null, "large", { ...said(m), size: id(p.i) });
    }
    const pick = (p: Placed) =>
      p.at === "between" ? (pref === "snug" ? p.lo : p.hi) : p.i;
    const onChart = placed.filter((x) => x.p.at !== "small");
    if (!onChart.length) {
      const { m, p } = placed[0];
      return result(null, "small", { ...said(m), size: id(pick(p)) });
    }
    // On a tie a between pick wins, so the fit move never leaves that measurement's sizes.
    const { m, p } = onChart.reduce((x, y) =>
      pick(y.p) > pick(x.p) || (pick(y.p) === pick(x.p) && y.p.at === "between")
        ? y
        : x,
    );
    if (p.at !== "between") return shifted("in", p.i, said(m));
    const at = pick(p);
    return result(at, "between", {
      ...said(m),
      below: id(p.lo),
      above: id(p.hi),
      size: id(at),
    });
  }

  const at = usual === undefined ? -1 : rows.findIndex((r) => r.id === usual);
  if (at >= 0) return shifted("usual", at, {});
  if (narrowed && rows.length === 1)
    return result(0, "choice", { size: id(0) });
  return none(bars);
}
