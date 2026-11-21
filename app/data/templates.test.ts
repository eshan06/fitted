import { describe, expect, it } from "vitest";
import { TEMPLATES, validateChart } from "../models/chart.server";
import {
  blankDraft,
  pickTemplate,
  setCell,
  toInput,
} from "../components/chart-table/model";
import { TEMPLATE_IDS, templateCard, templateContent } from "./templates";

const named = (t: (typeof TEMPLATES)[number]) => ({
  ...blankDraft(t),
  name: "Test",
});

describe("chart templates", () => {
  it("covers every template the chart field allows", () => {
    expect(TEMPLATE_IDS).toEqual([...TEMPLATES]);
  });

  it.each(TEMPLATE_IDS.filter((t) => t !== "blank"))(
    "%s saves as it starts, with no numbers",
    (t) => {
      const r = toInput(named(t));
      if (!("input" in r)) throw new Error(JSON.stringify(r.fieldErrors));
      expect(validateChart(r.input)).toEqual(r.input);
      const { tables, measure } = r.input.content;
      expect(tables).toHaveLength(1);
      expect(tables[0].rows.length).toBeGreaterThan(0);
      expect(tables[0].rows.every((r) => !Object.keys(r.cells).length)).toBe(
        true,
      );
      expect(tables[0].columns.some((c) => c.kind === "measure")).toBe(true);
      // The card counts the steps it sets up.
      const steps = /(\d) how-to-measure step/.exec(templateCard(t).extra);
      if (steps) expect(measure.steps).toHaveLength(Number(steps[1]));
    },
  );

  it("starts blank with only a Size column", () => {
    expect(templateContent("blank").tables).toEqual([
      { id: "t1", columns: [{ id: "size", kind: "size" }], rows: [] },
    ]);
  });
});

describe("picking a template in the editor", () => {
  it("fills a table that's still as its template set it up", () => {
    const d = pickTemplate({ ...blankDraft(), name: "Tops" }, "tops");
    expect(d).toEqual({ ...named("tops"), name: "Tops" });
    expect(pickTemplate(d, "shoes").content).toEqual(templateContent("shoes"));
  });

  it("only relabels a table with anything typed in it", () => {
    const typed = setCell(blankDraft("tops"), "r1", "bust", "32");
    const d = pickTemplate(typed, "dresses");
    expect(d.template).toBe("dresses");
    expect(d.content).toEqual(typed.content);
    expect(d.cells).toEqual(typed.cells);
  });
});
