import { describe, expect, it, vi } from "vitest";
import {
  createdSummary,
  recordVersion,
  staffName,
  summarize,
} from "./chart-history.server";
import type { ChartInput } from "./chart.server";

// The database, for a write that fails; db.server.test.ts covers the real one.
const db = vi.hoisted(() => ({ chartVersion: { findFirst: vi.fn() } }));
vi.mock("../db.server", () => ({ default: db }));

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

  it("counts many sizes, and names added measurements and a removed note", () => {
    const base = edit((c) => {
      c.content.words["t1.note"] = "Old";
    });
    const next = edit((c) => {
      const t = c.content.tables[0];
      for (const id of ["a", "b", "c", "d", "e"])
        t.rows.push({ id, cells: {} });
      t.columns.push({ id: "waist", kind: "measure", convert: true });
      c.content.words["t1.waist"] = "Waist";
    });
    expect(summarize(base, next)).toBe(
      "5 sizes added; Waist added; note removed",
    );
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
    // How a stored session reads back a name Shopify didn't send.
    expect(as("Priya", "null")).toBe("Priya");
    expect(as("null", "Nair")).toBe("Staff");
  });
});

describe("recording a version", () => {
  it("answers false and logs without the staff name when the database fails", async () => {
    db.chartVersion.findFirst.mockRejectedValue(new Error("connection lost"));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l) => logs.push(l));

    expect(
      await recordVersion("a.myshopify.com", "gid://x/1", chart(), "Priya N."),
    ).toBe(false);
    expect(JSON.parse(logs[0])).toEqual({
      level: "error",
      msg: "Version history write failed",
      shop: "a.myshopify.com",
      route: "chart-history",
      detail: "Error",
    });
    expect(logs.join()).not.toContain("Priya");
  });
});
