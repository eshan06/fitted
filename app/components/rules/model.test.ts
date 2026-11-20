import { describe, expect, it, vi } from "vitest";

vi.mock("../../shopify.server", () => ({}));
vi.mock("../../db.server", () => ({ default: {} }));
const { MAX_CHARTS: SERVER_MAX_CHARTS, validateRules } =
  await import("../../models/rules.server");
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

describe("rules draft", () => {
  it("ranks at most as many charts as the server allows", () => {
    expect(model.MAX_CHARTS).toBe(SERVER_MAX_CHARTS);
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
