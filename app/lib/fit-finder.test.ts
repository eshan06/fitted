import { describe, expect, it } from "vitest";
import {
  findSize,
  type Answers,
  type Chart,
  type Fit,
  type Table,
} from "./fit-finder";

// Women's tops, inches: the canvas's Linen Wrap Top chart.
const tops: Table = {
  id: "tops",
  columns: [
    { id: "size", kind: "size" },
    { id: "us", kind: "country", country: "US" },
    { id: "bust", kind: "measure", convert: true },
    { id: "waist", kind: "measure", convert: true },
    { id: "wt", kind: "measure", unit: "lb", convert: true },
    { id: "note", kind: "text" },
  ],
  rows: [
    { id: "xs", cells: { bust: [31, 32], waist: [24, 25], wt: [100, 115] } },
    { id: "s", cells: { bust: [33, 34], waist: [26, 27], wt: [115, 130] } },
    { id: "m", cells: { bust: [35, 36], waist: [28, 29], wt: [130, 145] } },
    { id: "l", cells: { bust: [37.5, 39], waist: [30.5, 32] } },
    { id: "xl", cells: { bust: [40.5, 42], waist: [33.5, 35] } },
  ],
};

const fit: Fit = {
  table: "tops",
  questions: [
    { id: "q1", kind: "measure", col: "bust", optional: true },
    { id: "q2", kind: "usual_size" },
    { id: "q3", kind: "fit" },
  ],
  ease: {},
  stretch: "none",
};

const chart = (over: Partial<Fit> = {}, tables = [tops]): Chart => ({
  unit: "in",
  tables,
  fit: { ...fit, ...over },
});
const bust = (value: number, unit: "in" | "cm" = "in") => ({ value, unit });
const run = (answers: Answers, over?: Partial<Fit>) =>
  findSize(chart(over), answers);

describe("a bust measurement", () => {
  it("inside a size's range picks that size and says why", () => {
    expect(run({ q1: bust(35.5), q3: "regular" })).toMatchObject({
      row: "m",
      reason: {
        key: "fit.reason.in",
        values: {
          col: "bust",
          value: 35.5,
          unit: "in",
          size: "m",
          fit: "regular",
        },
      },
    });
  });

  it("leaves fit out of the reason when the shopper didn't answer it", () => {
    expect(run({ q1: bust(35.5) }).reason.values).not.toHaveProperty("fit");
  });

  it("counts a range's ends as inside it", () => {
    expect(run({ q1: bust(33) }).row).toBe("s");
    expect(run({ q1: bust(34) }).row).toBe("s");
  });

  it("relaxed moves one size up and snug one down", () => {
    expect(run({ q1: bust(35.5), q3: "relaxed" })).toMatchObject({
      row: "l",
      reason: { key: "fit.reason.in.up", values: { from: "m", size: "l" } },
    });
    expect(run({ q1: bust(35.5), q3: "snug" })).toMatchObject({
      row: "s",
      reason: { key: "fit.reason.in.down", values: { from: "m", size: "s" } },
    });
  });

  it("never moves past the smallest or largest size", () => {
    expect(run({ q1: bust(31.5), q3: "snug" })).toMatchObject({
      row: "xs",
      reason: { key: "fit.reason.in", values: { size: "xs", fit: "snug" } },
    });
    expect(run({ q1: bust(41), q3: "relaxed" })).toMatchObject({
      row: "xl",
      reason: { key: "fit.reason.in", values: { size: "xl" } },
    });
  });

  it("between sizes takes the larger, or the smaller for a snug fit", () => {
    const between = {
      key: "fit.reason.between",
      values: { below: "m", above: "l" },
    };
    expect(run({ q1: bust(37) })).toMatchObject({ row: "l", reason: between });
    expect(run({ q1: bust(37), q3: "relaxed" })).toMatchObject({
      row: "l",
      reason: between,
    });
    expect(run({ q1: bust(37), q3: "snug" })).toMatchObject({
      row: "m",
      reason: { ...between, values: { ...between.values, size: "m" } },
    });
  });

  it("below the smallest size recommends nothing and names the smallest", () => {
    expect(run({ q1: bust(30), q2: "m" })).toMatchObject({
      row: null,
      reason: {
        key: "fit.reason.small",
        values: { col: "bust", value: 30, size: "xs" },
      },
    });
  });

  it("past the largest size recommends nothing and names the largest", () => {
    expect(run({ q1: bust(43), q3: "snug" })).toMatchObject({
      row: null,
      reason: {
        key: "fit.reason.large",
        values: { col: "bust", value: 43, size: "xl" },
      },
    });
  });

  it("converts centimeters to the chart's inches", () => {
    expect(run({ q1: bust(90, "cm") })).toMatchObject({
      row: "m",
      reason: { values: { value: 90, unit: "cm" } },
    });
  });

  it("reads single-value cells as exact sizes", () => {
    const points: Table = {
      id: "tops",
      columns: [{ id: "bust", kind: "measure", unit: "cm", convert: true }],
      rows: [
        { id: "s", cells: { bust: [86] } },
        { id: "m", cells: { bust: [91] } },
      ],
    };
    const go = (v: number) =>
      findSize(chart({}, [points]), { q1: bust(v, "cm") });
    expect(go(86).row).toBe("s");
    expect(go(88)).toMatchObject({
      row: "m",
      reason: { key: "fit.reason.between" },
    });
    expect(findSize(chart({}, [points]), { q1: bust(36) }).row).toBe(null);
  });
});

describe("ease and stretch", () => {
  it("adds ease to the shopper's measurement before matching", () => {
    // A garment chart: 2 in of ease puts a 33.5 in bust in M.
    expect(run({ q1: bust(33.5) }, { ease: { bust: 2 } }).row).toBe("m");
    expect(run({ q1: bust(33.5) }).row).toBe("s");
  });

  it("ignores ease that isn't a number", () => {
    expect(run({ q1: bust(35.5) }, { ease: { bust: NaN } }).row).toBe("m");
  });

  it("lets a stretchy garment fit just past a size's top value", () => {
    expect(run({ q1: bust(36.8) }).row).toBe("l");
    expect(run({ q1: bust(36.8) }, { stretch: "some" }).row).toBe("m");
    expect(run({ q1: bust(44) }, { stretch: "some" }).row).toBe(null);
    expect(run({ q1: bust(44) }, { stretch: "high" }).row).toBe("xl");
  });

  it("prefers the size whose own range holds the value over a stretched smaller one", () => {
    // XS stretched high reaches 33.92, but 33.5 is inside S itself.
    expect(run({ q1: bust(33.5) }, { stretch: "high" }).row).toBe("s");
    expect(run({ q1: bust(32.5) }, { stretch: "high" }).row).toBe("xs");
  });

  it("doesn't stretch weight", () => {
    const w = {
      stretch: "high" as const,
      questions: [
        { id: "w", kind: "measure" as const, col: "wt", optional: false },
      ],
    };
    expect(run({ w: { value: 150, unit: "lb" } }, w)).toMatchObject({
      row: null,
      reason: { key: "fit.reason.large" },
    });
  });
});

describe("several measurements", () => {
  const two = {
    questions: [
      ...fit.questions,
      { id: "q4", kind: "measure" as const, col: "waist", optional: true },
    ],
  };

  it("picks the size that fits the largest one", () => {
    expect(run({ q1: bust(33.5), q4: bust(28.5) }, two)).toMatchObject({
      row: "m",
      reason: { key: "fit.reason.in", values: { col: "waist" } },
    });
  });

  it("recommends nothing when any is past the largest size", () => {
    expect(run({ q1: bust(33.5), q4: bust(40) }, two)).toMatchObject({
      row: null,
      reason: { key: "fit.reason.large", values: { col: "waist" } },
    });
  });

  it("doesn't move a tie past a measurement that is between sizes", () => {
    const waistFirst = { questions: [two.questions[3], ...fit.questions] };
    for (const order of [two, waistFirst]) {
      // Bust in m, waist between m and l: snug stays m (s can't take the waist).
      expect(
        run({ q1: bust(35.5), q4: bust(29.5), q3: "snug" }, order),
      ).toMatchObject({
        row: "m",
        reason: { key: "fit.reason.between", values: { col: "waist" } },
      });
      // Bust in l, waist between m and l: relaxed stays l.
      expect(
        run({ q1: bust(38), q4: bust(30), q3: "relaxed" }, order).row,
      ).toBe("l");
    }
  });

  it("ignores one below the smallest size when another is on the chart", () => {
    expect(run({ q1: bust(35.5), q4: bust(20) }, two).row).toBe("m");
  });

  it("matches weight in pounds against kilograms typed in", () => {
    const w = {
      questions: [
        { id: "w", kind: "measure" as const, col: "wt", optional: false },
      ],
    };
    expect(run({ w: { value: 62, unit: "kg" } }, w).row).toBe("m");
    expect(run({ w: { value: 62, unit: "cm" } }, w)).toMatchObject({
      row: null,
      reason: { key: "fit.reason.none" },
    });
  });

  it("skips a column with no values in the remaining sizes", () => {
    const w = {
      questions: [
        { id: "w", kind: "measure" as const, col: "wt", optional: false },
        fit.questions[1],
        {
          id: "c",
          kind: "choice" as const,
          options: [{ id: "big", rows: ["l", "xl"] }],
        },
      ],
    };
    expect(
      run({ w: { value: 150, unit: "lb" }, q2: "l", c: "big" }, w).row,
    ).toBe("l");
    // Without the choice, 150 lb is past m's 145, the largest size with a weight.
    expect(run({ w: { value: 150, unit: "lb" }, q2: "l" }, w)).toMatchObject({
      row: null,
      reason: { key: "fit.reason.large", values: { size: "m" } },
    });
  });
});

describe("no measurement", () => {
  it("starts from the size they usually wear", () => {
    expect(run({ q2: "s" })).toMatchObject({
      row: "s",
      reason: { key: "fit.reason.usual", values: { size: "s" } },
    });
    expect(run({ q2: "s", q3: "relaxed" })).toMatchObject({
      row: "m",
      reason: {
        key: "fit.reason.usual.up",
        values: { from: "s", size: "m", fit: "relaxed" },
      },
    });
    expect(run({ q2: "xs", q3: "snug" }).row).toBe("xs");
  });

  it("recommends nothing with no answers, or an unknown usual size", () => {
    for (const answers of [{}, { q3: "relaxed" }, { q2: "xxl" }]) {
      expect(run(answers)).toMatchObject({ row: null });
      expect(run(answers).reason).toEqual({
        key: "fit.reason.none",
        values: {},
      });
    }
  });

  it("ignores measurements that aren't usable and falls back to the usual size", () => {
    for (const q1 of [
      bust(NaN),
      bust(0),
      bust(-3),
      bust(10000),
      bust(Infinity),
      "36",
      null,
      { value: 36, unit: "constructor" },
    ]) {
      expect(run({ q1: q1 as never, q2: "l" }).row).toBe("l");
    }
  });

  it("ignores a question on a column that isn't a measure", () => {
    const q = {
      questions: [
        { id: "n", kind: "measure" as const, col: "note", optional: true },
      ],
    };
    expect(run({ n: bust(36) }, q).row).toBe(null);
    expect(
      run(
        { n: bust(36) },
        {
          questions: [
            { id: "n", kind: "measure", col: "nope", optional: true },
          ],
        },
      ).row,
    ).toBe(null);
  });

  it("reads an unknown fit answer as regular", () => {
    expect(
      run({ q1: bust(35.5), q3: "baggy" }).reason.values,
    ).not.toHaveProperty("fit");
    expect(run({ q1: bust(35.5), q3: "baggy" }).row).toBe("m");
  });
});

describe("choice questions", () => {
  const cut = {
    questions: [
      ...fit.questions,
      {
        id: "q5",
        kind: "choice" as const,
        options: [
          { id: "petite", rows: ["xs", "s"] },
          { id: "one", rows: ["m"] },
          { id: "gone", rows: ["zz"] },
        ],
      },
    ],
  };

  it("narrows the sizes before matching", () => {
    expect(run({ q1: bust(35.5), q5: "petite" }, cut)).toMatchObject({
      row: null,
      reason: { key: "fit.reason.large", values: { size: "s" } },
    });
    expect(run({ q1: bust(32), q3: "relaxed", q5: "petite" }, cut).row).toBe(
      "s",
    );
    expect(run({ q2: "s", q3: "relaxed", q5: "petite" }, cut).row).toBe("s");
  });

  it("recommends the one size left even when the usual size was ruled out", () => {
    expect(run({ q5: "one", q2: "s" }, cut)).toMatchObject({
      row: "m",
      reason: { key: "fit.reason.choice" },
    });
  });

  it("recommends the one size left", () => {
    expect(run({ q5: "one" }, cut)).toMatchObject({
      row: "m",
      reason: { key: "fit.reason.choice", values: { size: "m" } },
    });
  });

  it("recommends nothing when the answers rule every size out", () => {
    expect(run({ q5: "gone", q1: bust(35.5) }, cut)).toMatchObject({
      row: null,
      bars: [],
    });
    expect(run({ q5: "petite", q2: "m" }, cut).row).toBe(null);
    expect(run({ q5: "petite" }, cut).row).toBe(null);
  });

  it("ignores an unknown option", () => {
    expect(run({ q5: "tall", q1: bust(35.5) }, cut).row).toBe("m");
    expect(run({ q5: "tall" }, cut).row).toBe(null);
  });
});

describe("fit bars", () => {
  it("score every size for each measured column, tight to loose", () => {
    const { bars } = run({ q1: bust(35.5) });
    expect(bars.map((b) => b.row)).toEqual(["xs", "s", "m", "l", "xl"]);
    const scores = bars.map((b) => b.cols.bust);
    expect(scores[2]).toBe(50);
    expect(scores[0]).toBeLessThan(scores[1]);
    expect(scores[3]).toBeGreaterThan(scores[2]);
    expect(scores[4]).toBeGreaterThan(scores[3]);
    expect(Math.min(...scores)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...scores)).toBeLessThanOrEqual(100);
    expect(bars[2].cols).not.toHaveProperty("waist");
  });

  it("clamp to 0 and 100 far from the chart", () => {
    expect(run({ q1: bust(80) }).bars[0].cols.bust).toBe(0);
    expect(run({ q1: bust(10) }).bars[4].cols.bust).toBe(100);
  });

  it("leave out sizes with no value in that column", () => {
    const w = {
      questions: [
        { id: "w", kind: "measure" as const, col: "wt", optional: false },
      ],
    };
    const { bars } = run({ w: { value: 137.5, unit: "lb" } }, w);
    expect(bars[2].cols.wt).toBe(50);
    expect(bars[3].cols).toEqual({});
  });

  it("still work with a single size", () => {
    const one: Table = { ...tops, rows: [tops.rows[2]] };
    expect(findSize(chart({}, [one]), { q1: bust(35.5) }).bars).toEqual([
      { row: "m", cols: { bust: 50 } },
    ]);
    expect(
      findSize(chart({}, [one]), { q1: bust(36) }).bars[0].cols.bust,
    ).toBeLessThan(50);
  });

  it("are empty with no measurement", () => {
    expect(
      run({ q2: "m" }).bars.every((b) => Object.keys(b.cols).length === 0),
    ).toBe(true);
  });
});

it("recommends nothing when the fit table is missing", () => {
  expect(run({ q1: bust(35.5) }, { table: "gone" })).toEqual({
    row: null,
    reason: { key: "fit.reason.none", values: {} },
    bars: [],
  });
});
