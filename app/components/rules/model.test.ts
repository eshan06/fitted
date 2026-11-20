import { describe, expect, it, vi } from "vitest";

vi.mock("../../shopify.server", () => ({}));
vi.mock("../../db.server", () => ({ default: {} }));
const {
  MAX_CHARTS: SERVER_MAX_CHARTS,
  MAX_IDS: SERVER_MAX_IDS,
  MAX_METAFIELDS: SERVER_MAX_METAFIELDS,
  validateRules,
} = await import("../../models/rules.server");
import type { Rules } from "../../models/rules.server";
import * as model from "./model";

const A = "gid://shopify/Metaobject/1";
const B = "gid://shopify/Metaobject/2";
const rules = (
  match: Rules["charts"][string]["match"],
  exclude = [],
): Rules => ({
  v: 1,
  order: [A],
  charts: { [A]: { match, exclude, auto: true } },
});
// The server's field errors for a document, none when it passes.
const refused = (r: Rules) => {
  try {
    validateRules(r);
    return {};
  } catch (err) {
    return (err as { fieldErrors: Record<string, string> }).fieldErrors;
  }
};

describe("rules draft", () => {
  it("ranks at most as many charts as the server allows", () => {
    expect(model.MAX_CHARTS).toBe(SERVER_MAX_CHARTS);
  });

  it("marks the 21st metafield, as the server would refuse it, and lets 20 through", () => {
    const keys = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => ({
        field: "metafield" as const,
        key: `custom.k${i + from}`,
        op: "is" as const,
        value: "x",
      }));
    // Twenty keys across two charts, one of them twice; refused keys don't count.
    const twenty: Rules = {
      v: 1,
      order: [A, B],
      charts: {
        [A]: { match: keys(12), exclude: [], auto: true },
        [B]: {
          match: [...keys(9, 11), { ...keys(1)[0], key: "app--1.fit" }],
          exclude: [],
          auto: true,
        },
      },
    };
    expect(model.limits(twenty).metafield).toBeUndefined();
    expect(() => validateRules(twenty)).toThrow(); // only the app key
    twenty.charts[B].match.pop();
    expect(() => validateRules(twenty)).not.toThrow();
    twenty.charts[B].exclude = keys(2, 20);
    const over = model.limits(twenty);
    expect(over.errors).toEqual({
      [`charts.${B}.exclude.0.key`]:
        "This would be the 21st metafield. The most is 20.",
    });
    expect(over.metafield).toBe(`charts.${B}.exclude.0.key`);
    expect(refused(twenty)[""]).toMatch(/at most 20 different/);
  });

  it("marks the condition whose picks go past 1,000, with its count and the total", () => {
    const ids = (n: number, kind = "Product") =>
      Array.from({ length: n }, (_, i) => `gid://shopify/${kind}/${i + 1}`);
    const r: Rules = {
      v: 1,
      order: [A, B],
      charts: {
        [A]: {
          match: [
            { field: "collection", op: "is", ids: ids(974, "Collection") },
          ],
          exclude: [],
          auto: true,
        },
        [B]: {
          match: [{ field: "product", op: "is", ids: ids(26) }],
          exclude: [],
          auto: true,
        },
      },
    };
    expect(model.limits(r).ids).toBeUndefined();
    expect(() => validateRules(r)).not.toThrow();
    r.charts[B].exclude = [{ field: "product", op: "is", ids: ids(38) }];
    r.charts[B].match.push({
      field: "collection",
      op: "is",
      ids: ids(1, "Collection"),
    });
    expect(model.limits(r)).toEqual({
      errors: {
        [`charts.${B}.match.1.ids`]:
          "1 collection picked here, 1,039 across all your charts. The most is 1,000.",
      },
      metafield: undefined,
      ids: { path: `charts.${B}.match.1.ids`, total: 1039 },
    });
    expect(refused(r)[""]).toMatch(/at most 1,000/);
    expect(model.MAX_IDS).toBe(SERVER_MAX_IDS);
    expect(model.MAX_METAFIELDS).toBe(SERVER_MAX_METAFIELDS);
  });

  it("names up to three picks, else counts them, and counts when a name is missing", () => {
    const names = { p1: "Linen wrap top", p2: "Tank", c1: "Women's tops" };
    const text = (field: string, ids: string[]) =>
      model.pickedText({ field, ids }, names);
    expect(text("collection", ["c1"])).toBe("Women's tops");
    expect(text("product", ["p1", "p2"])).toBe("Linen wrap top, Tank");
    expect(text("product", ["p1", "p9"])).toBe("2 products");
    expect(text("product", ["p1", "p2", "p1", "p2"])).toBe("4 products");
    expect(text("collection", [])).toBe("None picked yet");
  });

  it("counts a chart's products, with Shopify's cap as a floor", () => {
    expect(model.productCount({ count: 1, atLeast: false })).toBe("1 product");
    expect(model.productCount({ count: 1480, atLeast: false })).toBe(
      "1,480 products",
    );
    expect(model.productCount({ count: 10000, atLeast: true })).toBe(
      "10,000+ products",
    );
  });

  it("makes a blank condition of each field that the server accepts once filled", () => {
    for (const field of model.FIELDS) {
      const c = model.blank(field);
      if ("value" in c) c.value = "x";
      if ("key" in c) c.key = "custom.fit";
      if ("ids" in c)
        c.ids = [
          `gid://shopify/${field === "product" ? "Product" : "Collection"}/1`,
        ];
      expect(() => validateRules(rules([c]))).not.toThrow();
    }
  });

  it("keeps the comparison when the field changes, unless the new field can't use it", () => {
    const contains = {
      field: "tag" as const,
      op: "contains" as const,
      value: "x",
    };
    expect(model.blank("vendor", contains)).toEqual({
      field: "vendor",
      op: "contains",
      value: "",
    });
    expect(model.blank("collection", contains)).toEqual({
      field: "collection",
      op: "is",
      ids: [],
    });
    expect(model.blank("all", contains)).toEqual({ field: "all" });
  });

  it("drops charts with no conditions when saving, and keeps a chart with only exclusions", () => {
    const C = "gid://shopify/Metaobject/3";
    const draft: Rules = {
      v: 1,
      order: [A, C, B],
      charts: {
        [A]: { match: [{ field: "all" }], exclude: [], auto: true },
        [C]: { match: [], exclude: [], auto: true },
        [B]: {
          match: [],
          exclude: [{ field: "tag", op: "is", value: "x" }],
          auto: false,
        },
      },
    };
    expect(model.toSave(draft)).toEqual({
      v: 1,
      order: [A, B],
      charts: { [A]: draft.charts[A], [B]: draft.charts[B] },
    });
  });

  it("leaves deleted charts out of the order", () => {
    const r = rules([{ field: "all" }]);
    expect(model.forCharts(r, new Set([B])).order).toEqual([]);
    expect(model.forCharts(r, new Set([A])).order).toEqual([A]);
  });

  it("words each problem the way the canvas does", () => {
    const long = "a".repeat(269);
    expect(
      model.check(
        rules(
          [
            { field: "tag", op: "contains", value: " " },
            { field: "metafield", key: "app--4821.fit", op: "is", value: "x" },
            { field: "metafield", key: "custom fit", op: "is", value: "x" },
            { field: "product", op: "is", ids: [] },
          ],
          [{ field: "tag", op: "is", value: long }] as never,
        ),
      ),
    ).toEqual({
      [`charts.${A}.match.0.value`]: "Enter a tag, like women-top.",
      [`charts.${A}.match.1.key`]:
        "App metafields (starting app--) can't be used in rules. Pick one of your store's own, like custom.fit.",
      [`charts.${A}.match.2.key`]: "Use namespace.key, like custom.fit.",
      [`charts.${A}.match.3.ids`]: "Pick at least one.",
      [`charts.${A}.exclude.0.value`]:
        "This is 269 characters; the most is 255. Put one tag in each condition.",
    });
  });

  it("finds nothing wrong in rules the server accepts", () => {
    const r = rules([
      { field: "type", op: "is", value: "Shirts" },
      { field: "metafield", key: "custom.fit", op: "is", value: "slim" },
    ]);
    expect(model.check(r)).toEqual({});
    expect(() => validateRules(r)).not.toThrow();
  });

  it("points each field error at its control", () => {
    expect(model.elementId(`charts.${A}.match.2.key`)).toBe("r1-match-2-key");
    expect(model.elementId(`charts.${A}.exclude.0.ids`)).toBe(
      "r1-exclude-0-value",
    );
    expect(model.elementId(`charts.${A}.match.1.value`)).toBe(
      "r1-match-1-value",
    );
    expect(model.elementId(`charts.${A}.match.1`)).toBe("r1-match-1-field");
  });
});

describe("the banners' words", () => {
  it("words a resolve job's reason for the didn't-finish banner", () => {
    expect(model.reason(null)).toBe("Shopify stopped responding");
    expect(model.reason("Shopify request failed")).toBe(
      "Shopify stopped responding",
    );
    expect(model.reason("Shopify's bulk operation took too long")).toBe(
      "Shopify's bulk operation took too long",
    );
    expect(model.reason("The job stopped before it finished")).toBe(
      "Fitted stopped before it finished",
    );
    expect(model.reason("The saved display rules can't be read")).toBe(
      "the saved display rules can't be read",
    );
  });

  it("words saved rules' problems even when the stored document isn't rules", () => {
    const charts = [{ id: A, name: "Tops" }];
    const errors = {
      [`charts.${A}.match.0.ids`]: "Pick at least one",
      [`charts.${A}.match.1.key`]: "Rules can't use an app's own metafields",
    };
    const stored = {
      charts: {
        [A]: {
          match: [
            { field: "collection", ids: [] },
            { field: "metafield", key: "app--1.fit" },
          ],
        },
      },
    };
    expect(model.storedProblems(errors, stored, charts)).toEqual([
      "Tops: a collection condition has nothing picked",
      "Tops: a metafield condition belongs to an app, so rules can't use it",
    ]);
    expect(model.storedProblems(errors, "garbled", charts)).toEqual([
      "Tops: pick at least one",
      "Tops: rules can't use an app's own metafields",
    ]);
  });
});
