import { afterEach, describe, expect, it, vi } from "vitest";
import { type Admin, AdminApiError } from "./admin.server";

// The plan gates are pure; their module's Shopify and database clients aren't used here.
vi.mock("../shopify.server", () => ({}));
vi.mock("../db.server", () => ({ default: {} }));
import {
  MAX_CHARTS,
  MAX_IDS,
  MAX_METAFIELDS,
  type Product,
  type Rules,
  RulesConflictError,
  RulesPlanError,
  RulesValidationError,
  getRules,
  resolveChart,
  saveRules,
  validateRules,
} from "./rules.server";

const chart = (n: number) => `gid://shopify/Metaobject/${n}`;
const [C1, C2, C3] = [chart(1), chart(2), chart(3)];
const P1 = "gid://shopify/Product/11";
const COL1 = "gid://shopify/Collection/21";
const COL2 = "gid://shopify/Collection/22";

// Swimwear by tag (but never product 11), slim fits by collection or
// metafield, and a store default for everything else.
const rules = (): Rules => ({
  v: 1,
  order: [C1, C2, C3],
  charts: {
    [C1]: {
      match: [{ field: "tag", op: "is", value: "Swim" }],
      exclude: [{ field: "product", op: "is", ids: [P1] }],
      auto: true,
    },
    [C2]: {
      match: [
        { field: "collection", op: "is", ids: [COL1] },
        {
          field: "metafield",
          key: "custom.fit",
          op: "contains",
          value: "slim",
        },
      ],
      exclude: [{ field: "vendor", op: "is", value: "Acme" }],
      auto: false,
    },
    [C3]: { match: [{ field: "all" }], exclude: [], auto: true },
  },
});
const product = (over: Partial<Product> = {}): Product => ({
  id: "gid://shopify/Product/99",
  tags: [],
  productType: "",
  vendor: "",
  collectionIds: [],
  metafields: {},
  ...over,
});
const ALL = new Set([C1, C2, C3]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Draft = Record<string, any>;
// The field errors validateRules reports after `change` edits valid rules.
function errorsAfter(change: (r: Draft) => void) {
  const r = rules() as Draft;
  change(r);
  try {
    validateRules(r);
  } catch (err) {
    if (err instanceof RulesValidationError) return err.fieldErrors;
    throw err;
  }
  return {};
}
const condition = (c: unknown) => (r: Draft) => {
  r.charts[C1].match = [c];
};

describe("validateRules", () => {
  it("accepts every kind of condition and returns the rules", () => {
    const r = rules();
    r.charts[C3].match.push(
      { field: "type", op: "is_not", value: "Gift card" },
      { field: "vendor", op: "contains", value: "co" },
      { field: "product", op: "is_not", ids: [P1] },
      { field: "collection", op: "is_not", ids: [COL1, COL2] },
      { field: "metafield", key: "my-ns.size_2", op: "is", value: "XL" },
    );
    expect(validateRules(r)).toEqual(r);
    expect(validateRules({ v: 1, order: [], charts: {} })).toEqual({
      v: 1,
      order: [],
      charts: {},
    });
  });

  it("refuses what isn't a rules document", () => {
    expect(() => validateRules(null)).toThrow(RulesValidationError);
    expect(() => validateRules([])).toThrow(RulesValidationError);
    expect(errorsAfter((r) => (r.v = 2))).toEqual({ v: "Must be 1" });
    expect(errorsAfter((r) => (r.extra = 1))).toEqual({
      extra: "Unknown field",
    });
    expect(errorsAfter((r) => (r.order = "nope"))).toMatchObject({
      order: "Must list the charts",
    });
    expect(errorsAfter((r) => (r.charts = []))).toMatchObject({
      charts: "Must hold each chart's rules",
    });
  });

  it("keeps the priority list and the charts' rules in step", () => {
    expect(errorsAfter((r) => r.order.push("gid://shopify/Product/1"))).toEqual(
      { "order.3": "Not a chart" },
    );
    expect(errorsAfter((r) => r.order.push(C1))).toEqual({
      "order.3": "Listed twice",
    });
    expect(errorsAfter((r) => r.order.push(chart(4)))).toEqual({
      [`charts.${chart(4)}`]: "Missing this chart's rules",
    });
    expect(errorsAfter((r) => r.order.pop())).toEqual({
      [`charts.${C3}`]: "Not in the priority list",
    });
    expect(errorsAfter((r) => (r.charts[C1] = "tag"))).toEqual({
      [`charts.${C1}`]: "Must be the chart's rules",
    });
    expect(
      errorsAfter((r) => {
        r.charts[C1].auto = "yes";
        r.charts[C1].exclude = {};
        r.charts[C1].note = "x";
      }),
    ).toEqual({
      [`charts.${C1}.auto`]: "Must be true or false",
      [`charts.${C1}.exclude`]: "Must be a list",
      [`charts.${C1}.note`]: "Unknown field",
    });
  });

  it("refuses chart keys named like object properties", () => {
    const r = JSON.parse(
      `{"v":1,"order":[],"charts":{"__proto__":{"match":[],"exclude":[],"auto":true},"constructor":{}}}`,
    );
    expect(() => validateRules(r)).toThrow(RulesValidationError);
    try {
      validateRules(r);
    } catch (err) {
      expect((err as RulesValidationError).fieldErrors).toEqual({
        "charts.__proto__": "Not in the priority list",
        "charts.constructor": "Not in the priority list",
      });
    }
  });

  it("checks each condition's field, operator and values", () => {
    const p = `charts.${C1}.match.0`;
    expect(errorsAfter(condition({ field: "price", op: "is" }))).toEqual({
      [p]: "Pick what the rule matches on",
    });
    expect(errorsAfter(condition({ field: "constructor" }))).toEqual({
      [p]: "Pick what the rule matches on",
    });
    expect(errorsAfter(condition("tag"))).toEqual({
      [p]: "Pick what the rule matches on",
    });
    expect(errorsAfter(condition({ field: "all", op: "is" }))).toEqual({
      [`${p}.op`]: "Unknown field",
    });
    expect(
      errorsAfter(condition({ field: "product", op: "contains", ids: [P1] })),
    ).toEqual({ [`${p}.op`]: "Pick how it compares" });
    expect(
      errorsAfter(
        condition({ field: "collection", op: "is", ids: [P1], value: "x" }),
      ),
    ).toEqual({
      [`${p}.ids.0`]: "Not a collection",
      [`${p}.value`]: "Unknown field",
    });
    expect(
      errorsAfter(condition({ field: "product", op: "is", ids: [] })),
    ).toEqual({ [`${p}.ids`]: "Pick at least one" });
    expect(
      errorsAfter(condition({ field: "product", op: "is", ids: P1 })),
    ).toEqual({ [`${p}.ids`]: "Pick at least one" });
    for (const value of ["", "   ", "x".repeat(256), 7])
      expect(errorsAfter(condition({ field: "tag", op: "is", value }))).toEqual(
        { [`${p}.value`]: "Use 1 to 255 characters" },
      );
    expect(
      errorsAfter(
        condition({ field: "vendor", op: "is", value: "A", key: "x" }),
      ),
    ).toEqual({ [`${p}.key`]: "Unknown field" });
  });

  it("lets only plain namespace.key metafields through, since they go into query text", () => {
    const p = `charts.${C1}.match.0`;
    for (const key of [
      "fit",
      "custom.",
      ".fit",
      "custom.fit.extra",
      'custom.fit") { value } x: metafield(namespace: "a',
      "custom.fit }",
      "$app.chart",
      `${"n".repeat(65)}.fit`,
      `custom.${"k".repeat(65)}`,
      null,
    ])
      expect(
        errorsAfter(
          condition({ field: "metafield", key, op: "is", value: "x" }),
        ),
      ).toEqual({
        [`${p}.key`]: "Use namespace.key, with letters, digits, - and _",
      });
  });

  it(`names at most ${MAX_IDS} products and collections across all rules`, () => {
    const ids = (n: number, kind = "Product") =>
      Array.from({ length: n }, (_, i) => `gid://shopify/${kind}/${i + 1}`);
    const fill = (products: number) => (r: Draft) => {
      r.charts[C1].exclude = [
        { field: "product", op: "is", ids: ids(products) },
      ];
      r.charts[C2].match[0].ids = ids(MAX_IDS - 500, "Collection");
    };
    // C2 already names one collection; it is replaced above.
    expect(errorsAfter(fill(500))).toEqual({});
    expect(errorsAfter(fill(501))).toEqual({
      "": "Rules can name at most 1,000 products and collections. Use a tag or a collection for the rest.",
    });
  });

  it(`ranks at most ${MAX_CHARTS} charts and compares at most ${MAX_METAFIELDS} metafields`, () => {
    const rank = (n: number) => (r: Draft) => {
      r.order = Array.from({ length: n }, (_, i) => chart(i + 1));
      r.charts = Object.fromEntries(
        r.order.map((id: string) => [
          id,
          { match: [], exclude: [], auto: true },
        ]),
      );
    };
    expect(errorsAfter(rank(MAX_CHARTS))).toEqual({});
    expect(errorsAfter(rank(MAX_CHARTS + 1))).toEqual({
      order: `Rank at most ${MAX_CHARTS} charts`,
    });
    const compare = (n: number) => (r: Draft) => {
      r.charts[C3].match = Array.from({ length: n }, (_, i) => ({
        field: "metafield",
        key: `custom.k${i}`,
        op: "is",
        value: "x",
      }));
      // The same metafield again counts once.
      r.charts[C1].match.push({ ...r.charts[C3].match[0], op: "is_not" });
    };
    expect(errorsAfter(compare(MAX_METAFIELDS - 1))).toEqual({});
    expect(errorsAfter(compare(MAX_METAFIELDS))).toEqual({
      "": `Rules can compare at most ${MAX_METAFIELDS} different metafields`,
    });
  });

  it("refuses rules of 100 KB or more before walking them", () => {
    const r = rules() as Draft;
    r.charts[C1].match = Array.from({ length: 2000 }, () => ({
      field: "tag",
      op: "is",
      value: "x".repeat(50),
    }));
    expect(() => validateRules(r)).toThrow(
      expect.objectContaining({
        fieldErrors: {
          "": "The rules are too large. Use tags or collections instead of long product lists.",
        },
      }),
    );
    let deep: Draft = {};
    for (let i = 0; i < 20000; i++) deep = { deep };
    expect(() => validateRules({ v: 1, order: [], charts: deep })).toThrow(
      RulesValidationError,
    );
  });
});

describe("resolveChart", () => {
  it("gives the first Active chart in priority order that matches", () => {
    const swim = product({ tags: ["Swim"], collectionIds: [COL1] });
    expect(resolveChart(swim, rules(), ALL)).toBe(C1);
    const r = rules();
    r.order = [C2, C1, C3];
    expect(resolveChart(swim, r, ALL)).toBe(C2);
    expect(resolveChart(product(), rules(), ALL)).toBe(C3);
  });

  it("skips a chart that isn't Active, so its products fall through", () => {
    const swim = product({ tags: ["Swim"], collectionIds: [COL1] });
    expect(resolveChart(swim, rules(), new Set([C2, C3]))).toBe(C2);
    expect(resolveChart(swim, rules(), new Set([C3]))).toBe(C3);
    expect(resolveChart(swim, rules(), new Set())).toBeNull();
  });

  it("matches on any match condition and drops the chart on any exclude", () => {
    const viaCollection = product({ collectionIds: [COL2, COL1] });
    const viaMetafield = product({
      metafields: { "custom.fit": ["Slim fit"] },
    });
    expect(resolveChart(viaCollection, rules(), ALL)).toBe(C2);
    expect(resolveChart(viaMetafield, rules(), ALL)).toBe(C2);
    expect(
      resolveChart({ ...viaMetafield, vendor: " acme " }, rules(), ALL),
    ).toBe(C3);
    expect(
      resolveChart(product({ id: P1, tags: ["Swim"] }), rules(), ALL),
    ).toBe(C3);
  });

  it("returns null when nothing matches", () => {
    const r = rules();
    r.charts[C3].match = [];
    expect(resolveChart(product(), r, ALL)).toBeNull();
    expect(
      resolveChart(product(), { v: 1, order: [], charts: {} }, ALL),
    ).toBeNull();
  });

  // One chart whose only match condition is `c`.
  const matches = (c: Rules["charts"][string]["match"][number], p: Product) =>
    resolveChart(
      p,
      {
        v: 1,
        order: [C1],
        charts: { [C1]: { match: [c], exclude: [], auto: true } },
      },
      ALL,
    ) === C1;

  it("compares text trimmed and ignoring case; contains is a substring test", () => {
    const p = product({
      tags: ["Summer Sale", " swim "],
      productType: "One-Piece",
      vendor: "Acme Co",
    });
    expect(matches({ field: "tag", op: "is", value: "SWIM" }, p)).toBe(true);
    expect(matches({ field: "tag", op: "is", value: "sale" }, p)).toBe(false);
    expect(matches({ field: "tag", op: "contains", value: "sale" }, p)).toBe(
      true,
    );
    expect(matches({ field: "type", op: "is", value: " one-piece" }, p)).toBe(
      true,
    );
    expect(matches({ field: "type", op: "contains", value: "piece" }, p)).toBe(
      true,
    );
    expect(
      matches({ field: "vendor", op: "is_not", value: "acme co" }, p),
    ).toBe(false);
    expect(matches({ field: "vendor", op: "is_not", value: "Acme" }, p)).toBe(
      true,
    );
  });

  it("holds is and contains when any value matches, and is_not when none does", () => {
    const p = product({
      tags: ["a", "b"],
      collectionIds: [COL1, COL2],
      metafields: { "custom.colors": ["Red", "Navy blue"] },
    });
    const none = product();
    expect(matches({ field: "tag", op: "is_not", value: "b" }, p)).toBe(false);
    expect(matches({ field: "tag", op: "is_not", value: "b" }, none)).toBe(
      true,
    );
    expect(matches({ field: "collection", op: "is", ids: [COL2] }, p)).toBe(
      true,
    );
    expect(matches({ field: "collection", op: "is_not", ids: [COL2] }, p)).toBe(
      false,
    );
    expect(
      matches({ field: "collection", op: "is_not", ids: [COL2] }, none),
    ).toBe(true);
    const mf = { field: "metafield", key: "custom.colors" } as const;
    expect(matches({ ...mf, op: "is", value: "navy BLUE" }, p)).toBe(true);
    expect(matches({ ...mf, op: "contains", value: "blue" }, p)).toBe(true);
    expect(matches({ ...mf, op: "is_not", value: "red" }, p)).toBe(false);
    // A product without the metafield: is and contains fail, is_not holds.
    expect(matches({ ...mf, op: "is", value: "red" }, none)).toBe(false);
    expect(matches({ ...mf, op: "contains", value: "r" }, none)).toBe(false);
    expect(matches({ ...mf, op: "is_not", value: "red" }, none)).toBe(true);
  });

  it("matches products by id, and the store default matches everything", () => {
    expect(
      matches({ field: "product", op: "is", ids: [P1] }, product({ id: P1 })),
    ).toBe(true);
    expect(matches({ field: "product", op: "is", ids: [P1] }, product())).toBe(
      false,
    );
    expect(
      matches({ field: "product", op: "is_not", ids: [P1] }, product()),
    ).toBe(true);
    expect(matches({ field: "all" }, product())).toBe(true);
  });
});

const SHOP_ID = "gid://shopify/Shop/1";
const json = (body: unknown) => new Response(JSON.stringify(body));
// A store with one `$app.rules` metafield, enforcing compareDigest like Shopify.
function fakeStore(initial?: unknown) {
  let stored: { value: string; digest: string } | null =
    initial === undefined
      ? null
      : { value: JSON.stringify(initial), digest: "d0" };
  let n = 0;
  const hooks: { afterWrite?: () => void; userErrors?: unknown[] } = {};
  const graphql = vi.fn(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (query: string, opts?: { variables?: Record<string, any> }) => {
      if (query.includes("query FittedRules"))
        return json({
          data: {
            shop: {
              id: SHOP_ID,
              rules: stored && {
                jsonValue: JSON.parse(stored.value),
                compareDigest: stored.digest,
              },
            },
          },
        });
      expect(query).toContain("mutation SaveRules");
      const [input] = opts!.variables!.metafields;
      expect(opts!.variables!.metafields).toHaveLength(1);
      expect(input).toMatchObject({
        ownerId: SHOP_ID,
        namespace: "$app",
        key: "rules",
        type: "json",
      });
      const refuse = (userErrors: unknown[]) =>
        json({ data: { metafieldsSet: { metafields: [], userErrors } } });
      if (hooks.userErrors) return refuse(hooks.userErrors);
      // Like Shopify: null expects no value yet, and a left-out digest skips the check.
      if (
        input.compareDigest !== undefined &&
        input.compareDigest !== (stored?.digest ?? null)
      )
        return refuse([
          {
            field: ["metafields", "0"],
            message: "Stale",
            code: "STALE_OBJECT",
          },
        ]);
      stored = { value: input.value, digest: `d${++n}` };
      hooks.afterWrite?.();
      return json({
        data: {
          metafieldsSet: {
            metafields: [{ compareDigest: stored.digest }],
            userErrors: [],
          },
        },
      });
    },
  );
  const writes = () =>
    graphql.mock.calls.filter(([q]) => q.includes("mutation SaveRules")).length;
  return {
    admin: { graphql } as unknown as Admin,
    stored: () => (stored ? JSON.parse(stored.value) : null),
    hooks,
    writes,
  };
}

describe("reading and saving rules", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads empty rules with a null digest before the first save", async () => {
    const store = fakeStore();
    expect(await getRules(store.admin)).toEqual({
      rules: { v: 1, order: [], charts: {} },
      digest: null,
      shopId: SHOP_ID,
    });
  });

  it("saves the whole document and reads it back with the new digest", async () => {
    const store = fakeStore();
    const digest = await saveRules(store.admin, rules(), null, "pro");
    expect(store.stored()).toEqual(rules());
    expect(await getRules(store.admin)).toMatchObject({
      rules: rules(),
      digest,
    });
    // The digest goes back as loaded, so the next save checks against it.
    const next = rules();
    next.order.reverse();
    expect(await saveRules(store.admin, next, digest, "pro")).not.toBe(digest);
    expect(store.stored()).toEqual(next);
  });

  it("refuses a save over a newer one and keeps the newer one", async () => {
    const store = fakeStore(rules());
    const mine = rules();
    mine.order = [C3, C2, C1];
    await expect(saveRules(store.admin, mine, "d-old", "pro")).rejects.toThrow(
      RulesConflictError,
    );
    // Rules saved after this screen loaded with none are newer too.
    await expect(saveRules(store.admin, mine, null, "pro")).rejects.toThrow(
      RulesConflictError,
    );
    expect(store.stored()).toEqual(rules());
  });

  it("sends a digest that isn't text as null, never leaving the check out", async () => {
    const full = fakeStore(rules());
    const mine = rules();
    mine.order = [C3, C2, C1];
    for (const digest of [undefined, { d: "d0" }, 7])
      await expect(saveRules(full.admin, mine, digest, "pro")).rejects.toThrow(
        RulesConflictError,
      );
    expect(full.stored()).toEqual(rules());
  });

  it("counts a retried save whose first attempt landed as saved", async () => {
    vi.useFakeTimers();
    const store = fakeStore(rules());
    const mine = rules();
    mine.order = [C3, C2, C1];
    store.hooks.afterWrite = () => {
      store.hooks.afterWrite = undefined;
      throw new Error("socket hang up"); // the write landed, the answer didn't
    };
    const saving = saveRules(store.admin, mine, "d0", "pro");
    await vi.runAllTimersAsync();
    expect(await saving).toBe("d1");
    expect(store.stored()).toEqual(mine);
    expect(store.writes()).toBe(2);
  });

  it("counts a stale save as saved only when the store already holds exactly those rules", async () => {
    const store = fakeStore(rules());
    expect(await saveRules(store.admin, rules(), "d-old", "pro")).toBe("d0");
    const other = rules();
    other.charts[C3].auto = false;
    await expect(saveRules(store.admin, other, "d-old", "pro")).rejects.toThrow(
      RulesConflictError,
    );
    expect(store.writes()).toBe(2);
    expect(store.stored()).toEqual(rules());
  });

  it("never writes invalid rules", async () => {
    const store = fakeStore();
    await expect(
      saveRules(store.admin, { v: 1, order: [C1], charts: {} }, null, "pro"),
    ).rejects.toThrow(RulesValidationError);
    expect(store.writes()).toBe(0);
  });

  it("passes other refusals on as Shopify errors, not conflicts", async () => {
    const store = fakeStore();
    store.hooks.userErrors = [
      { field: ["value"], message: "Too big", code: "INVALID" },
    ];
    const err = await saveRules(store.admin, rules(), null, "pro").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err).not.toBeInstanceOf(RulesConflictError);
  });

  it("refuses a stored value that fails validation instead of reading it as no rules", async () => {
    const store = fakeStore({ v: 1, order: [C1], charts: {} });
    await expect(getRules(store.admin)).rejects.toThrow(RulesValidationError);
  });
});

describe("the Free plan's rule fields (§8)", () => {
  // Rules on products, collections and the store default only.
  const free = (): Rules => ({
    v: 1,
    order: [C1, C3],
    charts: {
      [C1]: {
        match: [{ field: "collection", op: "is", ids: [COL1] }],
        exclude: [{ field: "product", op: "is", ids: [P1] }],
        auto: true,
      },
      [C3]: { match: [{ field: "all" }], exclude: [], auto: true },
    },
  });

  it("saves product, collection and store default rules", async () => {
    const store = fakeStore();
    await saveRules(store.admin, free(), null, "free");
    expect(store.stored()).toEqual(free());
  });

  it("refuses a new tag, type, vendor or metafield condition, writing nothing", async () => {
    const store = fakeStore(free());
    const r = free();
    r.charts[C1].match.push({ field: "tag", op: "is", value: "Swim" });
    r.charts[C3].exclude.push({
      field: "metafield",
      key: "custom.fit",
      op: "is",
      value: "x",
    });
    const err = await saveRules(store.admin, r, "d0", "free").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RulesPlanError);
    expect((err as RulesPlanError).fieldErrors).toEqual({
      [`charts.${C1}.match.1`]:
        "Tag, type, vendor and metafield rules are on Standard and Pro",
      [`charts.${C3}.exclude.0`]:
        "Tag, type, vendor and metafield rules are on Standard and Pro",
    });
    expect(store.writes()).toBe(0);
    expect(await saveRules(store.admin, r, "d0", "standard")).toBe("d1");
  });

  it("keeps paid conditions saved before a downgrade, unchanged, but not edited or moved", async () => {
    const paid = rules();
    const store = fakeStore(paid);
    // A Free edit that leaves every paid condition as it was saves.
    const edit = rules();
    edit.charts[C1].exclude[0] = {
      field: "product",
      op: "is",
      ids: [P1, "gid://shopify/Product/12"],
    };
    edit.order = [C2, C1, C3];
    expect(await saveRules(store.admin, edit, "d0", "free")).toBe("d1");
    // Changing one, or moving it to the other list, is a new paid condition.
    const changed = structuredClone(edit) as Rules;
    changed.charts[C1].match[0] = { field: "tag", op: "is", value: "Swimwear" };
    const moved = structuredClone(edit) as Rules;
    moved.charts[C2].exclude = [
      ...moved.charts[C2].exclude,
      moved.charts[C2].match[1],
    ];
    for (const r of [changed, moved])
      await expect(saveRules(store.admin, r, "d1", "free")).rejects.toThrow(
        RulesPlanError,
      );
    expect(store.stored()).toEqual(edit);
  });
});
