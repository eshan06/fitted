import { describe, expect, it } from "vitest";
import {
  createdSummary,
  staffName,
  summarize,
  versionTime,
} from "./chart-history.server";
import type { ChartInput } from "./chart.server";

const chart = (): ChartInput => ({
  name: "Women's tops",
  template: "tops",
  content: {
    v: 1,
    unit: "in",
    roundTo: 0.5,
    tables: [
      {
        id: "t1",
        columns: [
          { id: "size", kind: "size" },
          { id: "bust", kind: "measure", convert: true },
          { id: "hips", kind: "measure", convert: true },
        ],
        rows: [
          { id: "s", cells: { bust: [33, 34], hips: [36, 37] } },
          { id: "m", cells: { bust: [35, 36], hips: [38, 39] } },
          { id: "l", cells: { bust: [37, 38], hips: [40, 41] } },
        ],
      },
    ],
    measure: { steps: [] },
    words: {
      "t1.size": "Size",
      "t1.bust": "Bust",
      "t1.hips": "Hips",
      "t1.s.size": "S",
      "t1.m.size": "M",
      "t1.l.size": "L",
    },
  },
});
const edit = (f: (c: ChartInput) => void) => {
  const c = chart();
  f(c);
  return c;
};

describe("a version's summary", () => {
  it("names the measurement and the sizes whose values changed", () => {
    const next = edit((c) => {
      c.content.tables[0].rows[1].cells.bust = [35, 37];
      c.content.tables[0].rows[2].cells.bust = [38];
    });
    expect(summarize(chart(), next)).toBe("Bust for M and L changed");
  });

  it("joins changes, notes and renames into one line", () => {
    const next = edit((c) => {
      c.content.tables[0].rows[0].cells.hips = [36, 38];
      c.content.words["t1.note"] = "Between sizes? Size up.";
    });
    expect(summarize(chart(), next)).toBe("Hips for S changed; note added");
    const renamed = edit((c) => (c.name = "Tops"));
    expect(summarize(chart(), renamed)).toBe("Renamed Tops");
  });

  it("says which sizes and measurements were added or removed", () => {
    const next = edit((c) => {
      const t = c.content.tables[0];
      t.rows = t.rows.filter((r) => r.id !== "l");
      t.rows.push({ id: "xl", cells: {} });
      c.content.words["t1.xl.size"] = "XL";
      t.columns = t.columns.filter((col) => col.id !== "hips");
    });
    expect(summarize(chart(), next)).toBe("XL added; L removed; Hips removed");
  });

  it("stays one short line when much changed", () => {
    const next = edit((c) => {
      c.name = "Tops";
      c.content.unit = "cm";
      c.content.tables[0].rows.forEach((r) => (r.cells.bust = [1]));
      c.content.words["t1.note"] = "New";
    });
    expect(summarize(chart(), next)).toBe(
      "Renamed Tops; units set to cm; Bust for S, M and L changed; more",
    );
  });

  it("falls back to details for changes it doesn't name", () => {
    const next = edit((c) => (c.content.words["tips"] = "Measure snug"));
    expect(summarize(chart(), next)).toBe("Details changed");
  });

  it("names the template a chart was created from", () => {
    expect(createdSummary(chart())).toBe("Created from the Tops template");
  });
});

describe("who saved a version", () => {
  const as = (first_name?: string, last_name?: string) =>
    staffName({
      onlineAccessInfo: {
        associated_user: { first_name, last_name },
      } as never,
    });

  it("keeps only the first name and last initial", () => {
    expect(as("Priya", "Nair")).toBe("Priya N.");
    expect(as("Priya", "")).toBe("Priya");
    expect(as(undefined, "Nair")).toBe("Staff");
    expect(staffName({})).toBe("Staff");
  });
});

describe("a version's time", () => {
  it("shows in the store's time zone", () => {
    const at = "2026-11-14T23:42:00Z";
    expect(versionTime(at, "America/Los_Angeles")).toBe(
      "Nov 14, 2026 · 3:42 PM",
    );
    expect(versionTime(at, "Asia/Kolkata")).toBe("Nov 15, 2026 · 5:12 AM");
  });
});
