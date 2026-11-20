import { describe as group, expect, it } from "vitest";
import { type FitChart, describe, formatEase, parseEase } from "./chart-fit";

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
