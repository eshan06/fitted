import { describe, expect, it } from "vitest";
import { ChartValidationError, validateChart } from "./chart.server";

const chart = () => ({
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
          { id: "us", kind: "country", country: "US" },
          { id: "chest", kind: "measure", convert: true },
          { id: "wt", kind: "measure", unit: "lb", convert: false },
          { id: "fitnote", kind: "text" },
        ],
        rows: [
          { id: "s", cells: { chest: [34, 35.5], wt: [120] } },
          { id: "m", cells: { chest: [36, 37.5] } },
          { id: "l", cells: {} },
        ],
        merges: [{ row: "s", col: "fitnote", rows: 3, cols: 1 }],
        wrap: ["fitnote"],
      },
    ],
    measure: { steps: ["bust"] },
    videoUrl: "https://www.youtube.com/watch?v=abc",
    fit: {
      table: "t1",
      questions: [
        { id: "q1", kind: "measure", col: "chest", optional: false },
        { id: "q2", kind: "usual_size" },
        { id: "q3", kind: "fit" },
        { id: "q4", kind: "choice", options: [{ id: "a", rows: ["s", "m"] }] },
      ],
      ease: { chest: 2, wt: -1 },
      stretch: "some",
    },
    words: {
      "t1.title": "Tops",
      "t1.sub": "Body measurements",
      "t1.note": "Between sizes? Size up.",
      "t1.size": "Size",
      "t1.chest": "Chest",
      "t1.s.size": "S",
      "t1.s.us": "4",
      "t1.s.fitnote": "Runs small",
      "m.bust.name": "Bust",
      "m.bust.text": "Around the fullest part",
      tips: "Measure over light clothing.",
      "fit.q1": "Your chest?",
      "fit.q4": "Body shape?",
      "fit.q4.a": "Straight",
    },
  },
});

type Draft = ReturnType<typeof chart> & Record<string, unknown>;
// The field errors validateChart reports after `change` edits a valid chart.
function errorsAfter(change: (c: Draft) => void) {
  const c = chart() as Draft;
  change(c);
  try {
    validateChart(c);
  } catch (e) {
    if (e instanceof ChartValidationError) return e.fieldErrors;
    throw e;
  }
  return {};
}
const table = (c: Draft) => c.content.tables[0] as Record<string, unknown>;

describe("validateChart", () => {
  it("accepts a full chart and returns it with the name trimmed", () => {
    const c = chart();
    const out = validateChart({ ...c, name: "  Women's tops  " });
    expect(out).toEqual(c);
  });

  it("accepts a minimal chart and keeps optional fields only when set", () => {
    const out = validateChart({
      name: "Rings",
      template: "rings",
      content: {
        v: 1,
        unit: "cm",
        roundTo: 1,
        tables: [
          {
            id: "a",
            columns: [{ id: "s", kind: "size" }],
            rows: [{ id: "r", cells: {} }],
          },
        ],
        measure: { steps: [] },
        words: {},
      },
      measureImage: "gid://shopify/MediaImage/123",
      importNote: "",
    });
    expect(out.measureImage).toBe("gid://shopify/MediaImage/123");
    expect(out).not.toHaveProperty("importNote");
  });

  it.each([
    [{ name: "" }, "name"],
    [{ name: "x".repeat(101) }, "name"],
    [{ name: "two\nlines" }, "name"],
    [{ template: "socks" }, "template"],
    [{ measureImage: "https://evil.example/a.png" }, "measureImage"],
    [{ measureImage: "gid://shopify/Video/1" }, "measureImage"],
    [{ importNote: "x".repeat(256) }, "importNote"],
    [{ owner: "someone" }, "owner"],
  ])("refuses bad top-level field %o", (patch, path) => {
    expect(errorsAfter((c) => Object.assign(c, patch))).toHaveProperty([path]);
  });

  it("refuses input that isn't a chart", () => {
    for (const bad of [null, "chart", [], { name: "A", template: "tops" }]) {
      expect(() => validateChart(bad)).toThrow(ChartValidationError);
    }
  });

  it.each([
    ["v", 2],
    ["unit", "mm"],
    ["roundTo", 0.1],
    ["measure", undefined],
    ["words", []],
    ["videoUrl", "http://www.youtube.com/watch?v=abc"],
    ["videoUrl", "https://youtube.com.evil.example/x"],
    ["videoUrl", "javascript:alert(1)"],
    ["extra", true],
  ])("refuses content.%s = %o", (key, value) => {
    const errs = errorsAfter((c) => {
      (c.content as Record<string, unknown>)[key] = value;
    });
    expect(errs).toHaveProperty([`content.${key}`]);
  });

  it("accepts Vimeo and youtu.be links", () => {
    for (const videoUrl of ["https://vimeo.com/1", "https://youtu.be/x"]) {
      expect(errorsAfter((c) => (c.content.videoUrl = videoUrl))).toEqual({});
    }
  });

  it("limits tables to 1 to 4, columns to 20 and rows to 60", () => {
    expect(errorsAfter((c) => (c.content.tables = []))).toHaveProperty([
      "content.tables",
    ]);
    const many = errorsAfter((c) => {
      const t = table(c);
      t.columns = [
        { id: "size", kind: "size" },
        ...Array.from({ length: 20 }, (_, i) => ({
          id: `c${i}`,
          kind: "text",
        })),
      ];
      t.rows = Array.from({ length: 61 }, (_, i) => ({
        id: `r${i}`,
        cells: {},
      }));
      t.merges = [];
      t.wrap = [];
    });
    expect(many).toHaveProperty(["content.tables.0.columns"]);
    expect(many).toHaveProperty(["content.tables.0.rows"]);
  });

  it("requires the first column, and only it, to be the size column", () => {
    const errs = errorsAfter((c) => {
      table(c).columns = [
        { id: "us", kind: "country", country: "US" },
        { id: "size", kind: "size" },
      ];
    });
    expect(errs).toHaveProperty(["content.tables.0.columns.0.kind"]);
    expect(errs).toHaveProperty(["content.tables.0.columns.1.kind"]);
  });

  it.each([
    [{ id: "us", kind: "country", country: "JP" }, "country"],
    [{ id: "us", kind: "measure", unit: "ft", convert: true }, "unit"],
    [{ id: "us", kind: "measure" }, "convert"],
    [{ id: "us", kind: "colour" }, "kind"],
    [{ id: "us", kind: "text", label: "x" }, "label"],
  ])("refuses column %o", (column, field) => {
    const errs = errorsAfter((c) => {
      (table(c).columns as unknown[])[1] = column;
    });
    expect(errs).toHaveProperty([`content.tables.0.columns.1.${field}`]);
  });

  it.each([
    ["Big", "is not lowercase"],
    ["toolongid", "is longer than 8"],
    ["title", "is reserved"],
    ["chest", "repeats a column id"],
  ])("refuses row id %s, which %s", (id) => {
    const errs = errorsAfter((c) => {
      (table(c).rows as { id: string }[])[2].id = id;
    });
    expect(errs).toHaveProperty(["content.tables.0.rows.2.id"]);
  });

  it.each<[unknown, string]>([
    [[0], "zero"],
    [[10000], "too large"],
    [[40, 38], "a range from high to low"],
    [[1, 2, 3], "three numbers"],
    [["36"], "text"],
    [36, "not a list"],
  ])("refuses the cell %o (%s)", (cell) => {
    const errs = errorsAfter((c) => {
      (table(c).rows as { cells: unknown }[])[1].cells = { chest: cell };
    });
    expect(errs).toHaveProperty(["content.tables.0.rows.1.cells.chest"]);
  });

  it("keeps numbers out of size, country and text columns", () => {
    const errs = errorsAfter((c) => {
      (table(c).rows as { cells: unknown }[])[1].cells = { us: [4] };
    });
    expect(errs).toHaveProperty(["content.tables.0.rows.1.cells.us"]);
  });

  it.each([
    [{ row: "x", col: "fitnote", rows: 1, cols: 1 }, "an unknown row"],
    [{ row: "s", col: "fitnote", rows: 4, cols: 1 }, "past the last row"],
    [{ row: "s", col: "fitnote", rows: 1, cols: 2 }, "past the last column"],
    [{ row: "s", col: "fitnote", rows: 0, cols: 1 }, "an empty span"],
    [{ row: "m", col: "fitnote", rows: 1, cols: 1 }, "an overlap"],
  ])("refuses merge %o with %s", (merge) => {
    const errs = errorsAfter((c) => {
      (table(c).merges as unknown[]).push(merge);
    });
    expect(errs).toHaveProperty(["content.tables.0.merges.1"]);
  });

  it.each(["merges", "wrap"])("refuses %s that is null", (key) => {
    const errs = errorsAfter((c) => (table(c)[key] = null));
    expect(errs).toHaveProperty([`content.tables.0.${key}`]);
  });

  it.each(["__proto__", "constructor", "toString"])(
    "refuses the top-level key %s",
    (key) => {
      const input = JSON.parse(JSON.stringify(chart()));
      Object.defineProperty(input, key, { value: 1, enumerable: true });
      let errs = {};
      try {
        validateChart(input);
      } catch (e) {
        errs = (e as ChartValidationError).fieldErrors;
      }
      expect(Object.keys(errs)).toEqual([key]);
    },
  );

  it.each([
    [(c: Draft) => (table(c).extra = 1), "content.tables.0.extra"],
    [
      (c: Draft) => ((table(c).rows as Record<string, unknown>[])[0].x = 1),
      "content.tables.0.rows.0.x",
    ],
    [
      (c: Draft) => ((table(c).merges as Record<string, unknown>[])[0].x = 1),
      "content.tables.0.merges.0.x",
    ],
    [
      (c: Draft) => ((c.content.measure as Record<string, unknown>).x = 1),
      "content.measure.x",
    ],
    [
      (c: Draft) => ((c.content.fit as Record<string, unknown>).x = 1),
      "content.fit.x",
    ],
    [
      (c: Draft) =>
        ((c.content.fit.questions[1] as Record<string, unknown>).x = 1),
      "content.fit.questions.1.x",
    ],
    [
      (c: Draft) =>
        ((
          c.content.fit.questions[3] as { options: Record<string, unknown>[] }
        ).options[0].x = 1),
      "content.fit.questions.3.options.0.x",
    ],
  ])("refuses unknown keys inside content (%#)", (change, path) => {
    expect(errorsAfter(change)).toHaveProperty([path]);
  });

  it.each([
    [
      (c: Draft) =>
        c.content.tables.push(
          ...Array.from({ length: 4 }, (_, i) => ({
            ...c.content.tables[0],
            id: `t${i + 2}`,
          })),
        ),
      "content.tables",
    ],
    [
      (c: Draft) =>
        (c.content.measure.steps = Array.from(
          { length: 21 },
          (_, i) => `s${i}`,
        )),
      "content.measure.steps",
    ],
    [
      (c: Draft) => (table(c).wrap = Array(21).fill("fitnote")),
      "content.tables.0.wrap",
    ],
    [
      (c: Draft) => ((table(c).rows as { cells: unknown }[])[0].cells = []),
      "content.tables.0.rows.0.cells",
    ],
    [
      (c: Draft) => ((table(c).rows as unknown[])[0] = "s"),
      "content.tables.0.rows.0",
    ],
    [
      (c: Draft) => ((table(c).merges as { cols: number }[])[0].cols = 0.5),
      "content.tables.0.merges.0",
    ],
    [(c: Draft) => (c.importNote = "two\nlines"), "importNote"],
    [
      (c: Draft) => (c.content.videoUrl = 5 as unknown as string),
      "content.videoUrl",
    ],
  ])("refuses out-of-bounds structure (%#)", (change, path) => {
    expect(errorsAfter(change)).toHaveProperty([path]);
  });

  it("refuses wrap on a column the table doesn't have", () => {
    const errs = errorsAfter((c) => (table(c).wrap = ["nope"]));
    expect(errs).toHaveProperty(["content.tables.0.wrap.0"]);
  });

  it("refuses a measuring step id used elsewhere in the chart", () => {
    const errs = errorsAfter((c) => (c.content.measure.steps = ["t1"]));
    expect(errs).toHaveProperty(["content.measure.steps.0"]);
  });

  it.each([
    [(f: Record<string, unknown>) => (f.table = "t9"), "content.fit"],
    [
      (f: Record<string, unknown>) => (f.stretch = "lots"),
      "content.fit.stretch",
    ],
    [
      (f: Record<string, unknown>) => (f.ease = { size: 1 }),
      "content.fit.ease.size",
    ],
    [
      (f: Record<string, unknown>) => (f.questions = []),
      "content.fit.questions",
    ],
    [
      (f: Record<string, unknown>) =>
        (f.questions = [
          { id: "q1", kind: "measure", col: "size", optional: true },
        ]),
      "content.fit.questions.0.col",
    ],
    [
      (f: Record<string, unknown>) =>
        (f.questions = [
          { id: "q1", kind: "choice", options: [{ id: "a", rows: ["xl"] }] },
        ]),
      "content.fit.questions.0.options.0.rows.0",
    ],
    [
      (f: Record<string, unknown>) =>
        (f.questions = [{ id: "q1", kind: "age" }]),
      "content.fit.questions.0.kind",
    ],
    [
      (f: Record<string, unknown>) => (f.ease = { chest: "2" }),
      "content.fit.ease.chest",
    ],
    [
      (f: Record<string, unknown>) => (f.ease = { chest: 10000 }),
      "content.fit.ease.chest",
    ],
    [
      (f: Record<string, unknown>) =>
        (f.questions = [
          { id: "q1", kind: "measure", col: "chest", optional: "no" },
        ]),
      "content.fit.questions.0.optional",
    ],
    [
      (f: Record<string, unknown>) =>
        (f.questions = [
          {
            id: "q1",
            kind: "choice",
            options: [
              { id: "a", rows: ["s"] },
              { id: "a", rows: ["m"] },
            ],
          },
        ]),
      "content.fit.questions.0.options.1.id",
    ],
    [
      (f: Record<string, unknown>) =>
        (f.questions = [
          { id: "q1", kind: "choice", options: [{ id: "note", rows: ["s"] }] },
        ]),
      "content.fit.questions.0.options.0.id",
    ],
    [
      (f: Record<string, unknown>) =>
        (f.questions = [
          { id: "q1", kind: "choice", options: [{ id: "a", rows: [] }] },
        ]),
      "content.fit.questions.0.options.0.rows",
    ],
  ])("refuses bad fit settings (%#)", (change, path) => {
    const errs = errorsAfter((c) => change(c.content.fit));
    expect(errs).toHaveProperty([path]);
  });

  it("refuses words the chart doesn't use and words that are too long", () => {
    const errs = errorsAfter((c) => {
      const w = c.content.words as Record<string, unknown>;
      w["t1.m.chest"] = "36"; // a number cell is not a word
      w["t2.title"] = "No such table";
      w["t1.title"] = "x".repeat(501);
      w["t1.sub"] = 5;
      w.tips = "x".repeat(2000);
    });
    expect(Object.keys(errs).sort()).toEqual([
      "content.words.t1.m.chest",
      "content.words.t1.sub",
      "content.words.t1.title",
      "content.words.t2.title",
    ]);
  });

  it("refuses content of 100 KB or more, and accepts one byte less", () => {
    // Pads words until the content JSON is exactly `bytes` long.
    const sized = (bytes: number) => {
      const c = chart() as Draft;
      const t = table(c);
      t.merges = [];
      const cols = t.columns as { id: string; kind: string }[];
      for (const id of ["n1", "n2", "n3"]) cols.push({ id, kind: "text" });
      const rows = t.rows as { id: string; cells: unknown }[];
      for (let i = 0; i < 57; i++) rows.push({ id: `x${i}`, cells: {} });
      const words = c.content.words as Record<string, string>;
      const size = () => Buffer.byteLength(JSON.stringify(c.content));
      for (const r of rows)
        for (const col of ["us", "fitnote", "n1", "n2", "n3"]) {
          const key = `t1.${r.id}.${col}`;
          words[key] = "";
          if (size() > bytes) delete words[key];
          else words[key] = "y".repeat(Math.min(500, bytes - size()));
        }
      expect(size()).toBe(bytes);
      return c;
    };
    expect(() => validateChart(sized(100 * 1024 - 1))).not.toThrow();
    const big = sized(100 * 1024) as Draft;
    big.name = "";
    big.content.unit = "mm"; // never reached: size is checked first
    expect(errorsAfter((c) => Object.assign(c, big))).toEqual({
      name: expect.any(String),
      content: expect.any(String),
    });
  });

  it("refuses content nested too deep to serialize", () => {
    let deep: unknown[] = [];
    for (let i = 0; i < 200000; i++) deep = [deep];
    const errs = errorsAfter((c) => (table(c).wrap = deep));
    expect(errs).toEqual({ content: expect.any(String) });
  });

  it("reports every problem at once, by field path", () => {
    const errs = errorsAfter((c) => {
      c.name = "";
      c.content.unit = "mm";
    });
    expect(Object.keys(errs)).toEqual(["name", "content.unit"]);
  });
});
