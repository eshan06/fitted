import { describe as group, expect, it } from "vitest";
import { type Answers, findSize } from "../../lib/fit-finder";
import {
  type FitChart,
  describe,
  formatEase,
  howItPicks,
  lastStep,
  parseEase,
  reasonText,
  sampleAnswers,
} from "./chart-fit";

// The FitFinder board's Women's tops: bust in inches and a weight in pounds.
const tops = (ease: Record<string, number> = { bust: 2 }): FitChart => ({
  id: "gid://shopify/Metaobject/2",
  updatedAt: "2026-11-01T00:00:00Z",
  name: "Women's tops",
  unit: "in",
  table: {
    id: "t1",
    columns: [
      { id: "size", kind: "size" },
      { id: "bust", kind: "measure", convert: true },
      { id: "waist", kind: "measure", unit: "cm", convert: true },
      { id: "wt", kind: "measure", unit: "lb", convert: true },
    ],
    rows: ["xs", "s", "m", "l", "xl"].map((id, i) => ({
      id,
      cells: { bust: [33 + 2 * i, 34 + 2 * i] },
    })),
  },
  fit: {
    table: "t1",
    questions: [
      { id: "q1", kind: "measure", col: "bust", optional: true },
      { id: "q2", kind: "usual_size" },
      { id: "q3", kind: "fit" },
    ],
    ease,
    stretch: "some",
  },
  words: {
    "t1.bust": "Bust",
    "t1.waist": "Waist",
    "t1.wt": "Weight",
    "t1.xs.size": "XS",
    "t1.xl.size": "XL",
    "fit.q1": "What's your bust measurement?",
    "fit.q2": "What size do you usually wear?",
    "fit.q3": "How do you like tops to fit?",
  },
});

group("ease, as the merchant types it", () => {
  it("shows the stored ease in the canvas's words, one part per column", () => {
    expect(formatEase(tops())).toBe("+2 in at bust");
    expect(formatEase(tops({ bust: 1.5, waist: -2 }))).toBe(
      "+1.5 in at bust, -2 cm at waist",
    );
    expect(formatEase(tops({}))).toBe("");
  });

  it("reads back what it shows", () => {
    const c = tops({ bust: 1.5, waist: -2, wt: 3 });
    expect(parseEase(c, formatEase(c))).toEqual(c.fit.ease);
  });

  it("reads a measurement by its label in any case, converting the unit", () => {
    expect(parseEase(tops(), "+2 in at bust")).toEqual({ bust: 2 });
    expect(parseEase(tops(), "5 cm at BUST")).toEqual({ bust: 1.97 });
    expect(parseEase(tops(), "1 in at waist, +.5 at bust")).toEqual({
      waist: 2.54,
      bust: 0.5,
    });
  });

  it("puts ease without a measurement on every one its unit fits", () => {
    expect(parseEase(tops(), "+1 in")).toEqual({ bust: 1, waist: 2.54 });
    expect(parseEase(tops(), "2")).toEqual({ bust: 2, waist: 2, wt: 2 });
  });

  it("refuses what doesn't read, and keeps an empty field as no ease", () => {
    for (const bad of [
      "two inches",
      "+2 in at sleeve",
      "+2 kg at bust",
      "in 2",
      "+2 in at bust, x",
      "10000 at bust",
    ])
      expect(parseEase(tops(), bad)).toBeNull();
    expect(parseEase(tops(), " ")).toEqual({});
  });
});

group("the questions list", () => {
  it("gives each question its words and kind, as the canvas draws them", () => {
    const c = tops();
    expect(c.fit.questions.map((q) => describe(c, q))).toEqual([
      {
        words: "What's your bust measurement?",
        kind: "Number, optional. Links to How to measure.",
      },
      {
        words: "What size do you usually wear?",
        kind: "Choice: XS to XL. Used when there's no measurement.",
      },
      {
        words: "How do you like tops to fit?",
        kind: "Choice: Snug, Regular, Relaxed",
      },
    ]);
  });

  it("names choice options, and falls back to ids for missing words", () => {
    const c = tops();
    c.words["fit.q4.a"] = "Under 18";
    const choice = {
      id: "q4",
      kind: "choice" as const,
      options: [
        { id: "a", rows: ["xs"] },
        { id: "b", rows: ["s"] },
      ],
    };
    expect(describe(c, choice)).toEqual({
      words: "q4",
      kind: "Choice: Under 18, b",
    });
    const required = { id: "q5", kind: "measure" as const, col: "bust" };
    expect(describe(c, { ...required, optional: false }).kind).toBe(
      "Number. Links to How to measure.",
    );
    // A size without words shows its row id; no measurement, no fallback line.
    delete c.words["t1.xs.size"];
    c.fit.questions = [{ id: "q2", kind: "usual_size" }];
    expect(describe(c, c.fit.questions[0]).kind).toBe("Choice: xs to XL.");
  });
});

const shoulders = {
  id: "q4",
  kind: "choice" as const,
  options: [
    { id: "a", rows: ["xs", "s"] },
    { id: "b", rows: ["m", "l"] },
  ],
};
// Women's tops with every size named, as a chart from the editor has them.
const named = (ease: Record<string, number> = { bust: 2 }) => {
  const c = tops(ease);
  Object.assign(c.words, {
    "t1.s.size": "S",
    "t1.m.size": "M",
    "t1.l.size": "L",
  });
  c.words["fit.q4"] = "Which best describes your shoulders?";
  c.words["fit.q4.b"] = "Broad";
  return c;
};

group("how Fitted picks a size", () => {
  it("says the canvas's three lines for Women's tops", () => {
    expect(howItPicks(named())).toEqual([
      "Match the shopper's bust measurement to the Women's tops chart.",
      "Relaxed fit moves one size up. Snug moves one size down, never below XS.",
      "No measurement? Start from the size they usually wear.",
    ]);
  });

  it("names choices first, then every measurement once, largest size winning", () => {
    const c = named();
    c.fit.questions = [
      { id: "q1", kind: "measure", col: "bust", optional: true },
      { id: "q5", kind: "measure", col: "waist", optional: false },
      { id: "q6", kind: "measure", col: "bust", optional: false },
      shoulders,
    ];
    expect(howItPicks(c)).toEqual([
      `Shoppers who answer "Which best describes your shoulders?" only get that answer's sizes.`,
      "Match the shopper's bust and waist measurements to the Women's tops chart. The largest size wins.",
    ]);
  });

  it("starts from the usual size when nothing is measured", () => {
    const c = named();
    c.fit.questions = [
      { id: "q2", kind: "usual_size" },
      { id: "q3", kind: "fit" },
    ];
    expect(howItPicks(c)).toEqual([
      "Start from the size they usually wear.",
      "Relaxed fit moves one size up. Snug moves one size down, never below XS.",
    ]);
  });
});

group("what shoppers see", () => {
  it("answers as a shopper in the middle size who likes a regular fit", () => {
    const c = named();
    c.fit.questions.push(shoulders, {
      id: "q5",
      kind: "measure",
      col: "waist", // M has no waist, so it goes unanswered
      optional: true,
    });
    expect(sampleAnswers(c)).toEqual({
      q1: { value: 37.5, unit: "in" },
      q2: "m",
      q3: "regular",
      q4: "b",
    });
  });

  it("draws the last question with the sample's answer marked", () => {
    const c = named();
    const step = (q: FitChart["fit"]["questions"][number]) => {
      c.fit.questions = [q];
      return lastStep(c, sampleAnswers(c));
    };
    expect(step({ id: "q3", kind: "fit" })).toEqual({
      words: "How do you like tops to fit?",
      options: [
        { label: "Snug", on: false },
        { label: "Regular", on: true },
        { label: "Relaxed", on: false },
      ],
    });
    expect(step({ id: "q2", kind: "usual_size" }).options).toEqual(
      ["XS", "S", "M", "L", "XL"].map((label) => ({
        label,
        on: label === "M",
      })),
    );
    expect(
      step({ id: "q1", kind: "measure", col: "bust", optional: true }),
    ).toEqual({
      words: "What's your bust measurement?",
      options: [{ label: "37.5 in", on: true }],
    });
    expect(step(shoulders).options).toEqual([
      { label: "a", on: false },
      { label: "Broad", on: true },
    ]);
  });

  // Each reason as findSize gives it on Women's tops (bust 33-34 for XS, two
  // inches a size), and the sample's 37.5 in bust.
  const reason = (
    c: FitChart,
    answers: Answers = sampleAnswers(c),
    stretch: FitChart["fit"]["stretch"] = "none",
  ) =>
    reasonText(
      c,
      findSize(
        { unit: c.unit, tables: [c.table], fit: { ...c.fit, stretch } },
        answers,
      ),
    );
  it("says why, in the canvas's words, naming the ease it added", () => {
    expect(reason(named({}))).toBe(
      "Your 37.5 in bust falls in M on this chart, and you like a regular fit.",
    );
    // 37.5 in is M on the chart; with 2 in of ease it's L.
    expect(reason(named())).toBe(
      "Your 37.5 in bust with 2 in of ease falls in L on this chart, and you like a regular fit.",
    );
    expect(reason(named({ bust: 1.25 }))).toBe(
      "Your 37.5 in bust with 1.25 in of ease falls between M and L on this chart, and you like a regular fit, so L.",
    );
    // Some stretch lets M reach 38.75 in, past its own 38, and says so.
    expect(reason(named({ bust: 1.25 }), undefined, "some")).toBe(
      "Your 37.5 in bust with 1.25 in of ease falls in M on this chart, counting the fabric's stretch, and you like a regular fit.",
    );
    // Within M's own range, stretch goes unmentioned.
    expect(reason(named({ bust: 0.5 }), undefined, "high")).toBe(
      "Your 37.5 in bust with 0.5 in of ease falls in M on this chart, and you like a regular fit.",
    );
  });

  it("says why off the chart, and from the usual size or the choices", () => {
    expect(reason(named({ bust: 10 }))).toBe(
      "Your 37.5 in bust with 10 in of ease is past XL, the largest size on this chart.",
    );
    expect(reason(named({ bust: -10 }))).toBe(
      "Your 37.5 in bust with -10 in of ease is below XS, the smallest size on this chart.",
    );
    expect(reason(named(), { q2: "m", q3: "regular" })).toBe(
      "You usually wear M, and you like a regular fit.",
    );
    const c = named();
    c.fit.questions = [{ ...shoulders, options: [{ id: "a", rows: ["s"] }] }];
    expect(reason(c, { q4: "a" })).toBe(
      "Your answers leave only S on this chart.",
    );
    expect(reason(named(), {})).toBe("");
  });
});
