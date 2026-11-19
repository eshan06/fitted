// Display rules (ARCHITECTURE §6): which chart each product shows. The rules
// live in the `$app.rules` shop metafield, written whole; resolveChart is the
// pure function whose answer the resolver writes to each product's `$app.chart`.
import { isDeepStrictEqual } from "node:util";
import { type Admin, AdminApiError, adminGraphql } from "./admin.server";
import { type Plan, canUseRuleField } from "./billing.server";

export type Condition =
  | { field: "all" } // the "Store default: Everything else" entry
  | { field: "product" | "collection"; op: "is" | "is_not"; ids: string[] }
  | {
      field: "tag" | "type" | "vendor";
      op: "is" | "is_not" | "contains";
      value: string;
    }
  | {
      field: "metafield";
      key: string;
      op: "is" | "is_not" | "contains";
      value: string;
    };
export type Rules = {
  v: 1;
  order: string[]; // chart GIDs, highest priority first
  charts: Record<
    string,
    { match: Condition[]; exclude: Condition[]; auto: boolean }
  >;
};
export type Product = {
  id: string;
  tags: string[];
  productType: string;
  vendor: string;
  collectionIds: string[];
  metafields: Record<string, string[]>; // by namespace.key; a list's every value
};

export type FieldErrors = Record<string, string>;
export class RulesValidationError extends Error {
  constructor(readonly fieldErrors: FieldErrors) {
    super("The rules have invalid fields");
  }
}
/** A condition the plan doesn't include (§8): routes answer 403 with the upgrade path. */
export class RulesPlanError extends Error {
  constructor(readonly fieldErrors: FieldErrors) {
    super("The plan doesn't include these rules");
  }
}
/** Someone saved since this screen loaded: routes answer 409 (§15). */
export class RulesConflictError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const GID: Record<string, RegExp> = {
  chart: /^gid:\/\/shopify\/Metaobject\/\d+$/,
  product: /^gid:\/\/shopify\/Product\/\d+$/,
  collection: /^gid:\/\/shopify\/Collection\/\d+$/,
};
// Written into query text, so nothing but these characters gets through.
const KEY = /^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,64}$/;
const TEXT = ["is", "is_not", "contains"];
const FIELDS: Record<string, { keys: string[]; ops: string[] }> = {
  all: { keys: [], ops: [] },
  product: { keys: ["op", "ids"], ops: ["is", "is_not"] },
  collection: { keys: ["op", "ids"], ops: ["is", "is_not"] },
  tag: { keys: ["op", "value"], ops: TEXT },
  type: { keys: ["op", "value"], ops: TEXT },
  vendor: { keys: ["op", "value"], ops: TEXT },
  metafield: { keys: ["key", "op", "value"], ops: TEXT },
};
export const MAX_IDS = 1000;
// These two keep one product's resolve query, which reads every ranked chart's
// status and every compared metafield, under Shopify's query cost limit.
export const MAX_CHARTS = 200;
export const MAX_METAFIELDS = 20;

/** The whole document for a write. Throws RulesValidationError. */
export function validateRules(input: unknown): Rules {
  const errs: FieldErrors = Object.create(null);
  const fail = (path: string, message: string) => void (errs[path] ??= message);
  if (!isObj(input))
    throw new RulesValidationError({ "": "Must be display rules" });
  let bytes = Infinity;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input));
  } catch {
    // nesting too deep to serialize counts as too large
  }
  if (bytes >= 100 * 1024)
    throw new RulesValidationError({
      "": "The rules are too large. Use tags or collections instead of long product lists.",
    });
  for (const k of Object.keys(input))
    if (!["v", "order", "charts"].includes(k)) fail(k, "Unknown field");
  if (input.v !== 1) fail("v", "Must be 1");
  const order = Array.isArray(input.order) ? input.order : [];
  const charts = isObj(input.charts) ? input.charts : {};
  if (!Array.isArray(input.order)) fail("order", "Must list the charts");
  else if (order.length > MAX_CHARTS)
    fail("order", `Rank at most ${MAX_CHARTS} charts`);
  if (!isObj(input.charts)) fail("charts", "Must hold each chart's rules");
  order.forEach((id, i) => {
    if (typeof id !== "string" || !GID.chart.test(id))
      fail(`order.${i}`, "Not a chart");
    else if (order.indexOf(id) !== i) fail(`order.${i}`, "Listed twice");
    else if (!Object.hasOwn(charts, id))
      fail(`charts.${id}`, "Missing this chart's rules");
  });
  let ids = 0;
  const keys = new Set<string>();
  for (const [id, rule] of Object.entries(charts)) {
    const p = `charts.${id}`;
    if (!order.includes(id)) fail(p, "Not in the priority list");
    else if (!isObj(rule)) fail(p, "Must be the chart's rules");
    else {
      for (const k of Object.keys(rule))
        if (!["match", "exclude", "auto"].includes(k))
          fail(`${p}.${k}`, "Unknown field");
      if (typeof rule.auto !== "boolean")
        fail(`${p}.auto`, "Must be true or false");
      for (const list of ["match", "exclude"]) {
        const conditions = rule[list];
        if (!Array.isArray(conditions)) fail(`${p}.${list}`, "Must be a list");
        else
          conditions.forEach(
            (c, ci) =>
              (ids += checkCondition(c, `${p}.${list}.${ci}`, fail, keys)),
          );
      }
    }
  }
  if (ids > MAX_IDS)
    fail(
      "",
      `Rules can name at most ${MAX_IDS.toLocaleString("en-US")} products and collections. Use a tag or a collection for the rest.`,
    );
  if (keys.size > MAX_METAFIELDS)
    fail(
      "",
      `Rules can compare at most ${MAX_METAFIELDS} different metafields`,
    );
  if (Object.keys(errs).length) throw new RulesValidationError(errs);
  return input as Rules;
}

// Reports a bad condition's problems and adds its metafield to `keys`;
// returns how many ids it names.
function checkCondition(
  c: unknown,
  p: string,
  fail: (path: string, message: string) => void,
  keys: Set<string>,
): number {
  const field = isObj(c) && typeof c.field === "string" ? c.field : "";
  if (!isObj(c) || !Object.hasOwn(FIELDS, field)) {
    fail(p, "Pick what the rule matches on");
    return 0;
  }
  const { keys: allowed, ops } = FIELDS[field];
  for (const k of Object.keys(c))
    if (k !== "field" && !allowed.includes(k))
      fail(`${p}.${k}`, "Unknown field");
  if (ops.length && !ops.includes(c.op as string))
    fail(`${p}.op`, "Pick how it compares");
  if (allowed.includes("key")) {
    if (typeof c.key !== "string" || !KEY.test(c.key))
      fail(`${p}.key`, "Use namespace.key, with letters, digits, - and _");
    // Apps' own namespaces: another app's can't be read, and Fitted's holds
    // `chart`, so a product's chart would depend on itself.
    else if (/^app--/i.test(c.key))
      fail(`${p}.key`, "Rules can't use an app's own metafields");
    else keys.add(c.key);
  }
  if (
    allowed.includes("value") &&
    (typeof c.value !== "string" || !c.value.trim() || c.value.length > 255)
  )
    fail(`${p}.value`, "Use 1 to 255 characters");
  if (!allowed.includes("ids")) return 0;
  if (!Array.isArray(c.ids) || !c.ids.length) {
    fail(`${p}.ids`, "Pick at least one");
    return 0;
  }
  c.ids.forEach(
    (id, i) =>
      (typeof id === "string" && GID[field].test(id)) ||
      fail(`${p}.ids.${i}`, `Not a ${field}`),
  );
  return c.ids.length;
}

const norm = (s: string) => s.trim().toLowerCase();
function holds(c: Condition, p: Product): boolean {
  if (c.field === "all") return true;
  if ("ids" in c) {
    const mine = c.field === "product" ? [p.id] : p.collectionIds;
    return mine.some((id) => c.ids.includes(id)) === (c.op === "is");
  }
  const values = (
    "key" in c
      ? (p.metafields[c.key] ?? [])
      : c.field === "tag"
        ? p.tags
        : [c.field === "type" ? p.productType : p.vendor]
  ).map(norm);
  const want = norm(c.value);
  if (c.op === "contains") return values.some((v) => v.includes(want));
  return values.includes(want) === (c.op === "is");
}

/** The chart a product shows (§6): the first Active chart in order that matches it, or null. */
export function resolveChart(
  product: Product,
  rules: Rules,
  activeChartIds: ReadonlySet<string>,
): string | null {
  return (
    rules.order.find((id) => {
      const rule = rules.charts[id];
      return (
        activeChartIds.has(id) &&
        rule.match.some((c) => holds(c, product)) &&
        !rule.exclude.some((c) => holds(c, product))
      );
    }) ?? null
  );
}

// Reads and writes of the rules (§6, §15).
type Stored = { jsonValue: unknown; compareDigest: string } | null;
async function readRules(admin: Admin) {
  const { shop } = await adminGraphql<{
    shop: { id: string; rules: Stored };
  }>(
    admin,
    `#graphql
    query FittedRules {
      shop {
        id
        rules: metafield(namespace: "$app", key: "rules") {
          jsonValue
          compareDigest
        }
      }
    }`,
    {},
    { retry: true },
  );
  return shop;
}
/** The saved rules fail validation: nothing resolves from them, and a valid save with `digest` replaces them. */
export class StoredRulesError extends Error {
  constructor(
    readonly fieldErrors: FieldErrors,
    readonly digest: string,
  ) {
    super("The saved display rules can't be read");
  }
}
// A stored value that fails validation throws, so a resolve stops instead of
// unassigning every product.
function parse(stored: Stored): Rules {
  if (!stored) return { v: 1, order: [], charts: {} };
  try {
    return validateRules(stored.jsonValue);
  } catch (err) {
    if (!(err instanceof RulesValidationError)) throw err;
    throw new StoredRulesError(err.fieldErrors, stored.compareDigest);
  }
}

export async function getRules(admin: Admin) {
  const shop = await readRules(admin);
  const digest = shop.rules?.compareDigest ?? null;
  return { rules: parse(shop.rules), digest, shopId: shop.id };
}

/**
 * Writes the whole document over the one with `digest`, the one place a
 * browser's value is trusted, and returns the new digest. On Free, conditions
 * on paid fields must already be saved, unchanged (§8). Callers then start a
 * merchant resolve.
 */
export async function saveRules(
  admin: Admin,
  input: unknown,
  digest: unknown,
  plan: Plan,
): Promise<string> {
  const rules = validateRules(input);
  const shop = await readRules(admin);
  const sent = typeof digest === "string" ? digest : null;
  let stored: Rules | null = null; // saved rules that can't be read keep nothing
  try {
    stored = parse(shop.rules);
  } catch (err) {
    if (!(err instanceof StoredRulesError)) throw err;
  }
  const paid: FieldErrors = Object.create(null);
  for (const [id, rule] of Object.entries(rules.charts))
    for (const list of ["match", "exclude"] as const)
      rule[list].forEach((c, i) => {
        if (
          !canUseRuleField(plan, c.field) &&
          !stored?.charts[id]?.[list].some((s) => isDeepStrictEqual(s, c))
        )
          paid[`charts.${id}.${list}.${i}`] =
            "Tag, type, vendor and metafield rules are on Standard and Pro";
      });
  // A copy from before someone else's save needs a reload more than an upgrade.
  if (Object.keys(paid).length)
    throw sent === (shop.rules?.compareDigest ?? null)
      ? new RulesPlanError(paid)
      : new RulesConflictError("The rules changed since they loaded");
  try {
    const data = await adminGraphql<{
      metafieldsSet: { metafields: { compareDigest: string }[] };
    }>(
      admin,
      `#graphql
      mutation SaveRules($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { compareDigest }
          userErrors { field message code }
        }
      }`,
      {
        metafields: [
          {
            ownerId: shop.id,
            namespace: "$app",
            key: "rules",
            type: "json",
            value: JSON.stringify(rules),
            compareDigest: sent, // never omitted: an omitted digest skips the check
          },
        ],
      },
      { retry: true },
    );
    return data.metafieldsSet.metafields[0].compareDigest;
  } catch (err) {
    const stale =
      err instanceof AdminApiError &&
      err.userErrors.some((e) =>
        ["STALE_OBJECT", "INVALID_COMPARE_DIGEST"].includes(e.code ?? ""),
      );
    if (!stale) throw err;
    // A retry whose first attempt landed comes back stale too (§15).
    const now = await getRules(admin);
    if (now.digest && isDeepStrictEqual(now.rules, rules)) return now.digest;
    throw new RulesConflictError("The rules changed since they loaded");
  }
}
