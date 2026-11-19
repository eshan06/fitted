// Display rules (ARCHITECTURE §6): which chart each product shows. The rules
// live in the `$app.rules` shop metafield, written whole; resolveChart is the
// pure function whose answer the resolver writes to each product's `$app.chart`,
// for the whole catalog in a resolve job (§13).
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { type Admin, AdminApiError, adminGraphql } from "./admin.server";
import { type Plan, canUseRuleField } from "./billing.server";
import { chartPages } from "./chart.server";

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

// Full resolves (§6, §13). A pass reads every product's facts and current
// chart with a bulk query, sets the charts that change with one bulk mutation
// (25 metafields a line) and removes the ones nothing matches 25 at a time. A
// job runs two passes: the second catches products edited during the first,
// and redoes what Shopify refused in it.
type Touch = () => Promise<unknown>;
type Line = Record<string, unknown> & { id: string; __parentId?: string };
type ProductLine = Line &
  Pick<Product, "tags" | "productType" | "vendor"> & {
    chart: { value: string } | null;
  };
type Metafield = { type: string; value: string } | null;
const CHART = { namespace: "$app", key: "chart" };
const conditions = (rules: Rules) =>
  Object.values(rules.charts).flatMap((r) => [...r.match, ...r.exclude]);
const namesCollection = (rules: Rules) =>
  conditions(rules).some((c) => c.field === "collection");
const comparedKeys = (rules: Rules) => [
  ...new Set(
    conditions(rules).flatMap((c) => (c.field === "metafield" ? [c.key] : [])),
  ),
];

// A product's facts and current chart. Compared metafields come back as m0,
// m1, ...; their keys passed KEY, so they are safe in query text.
const factFields = (keys: string[]) =>
  `id tags productType vendor chart: metafield(namespace: "$app", key: "chart") { value }` +
  keys
    .map((k, i) => {
      const [namespace, key] = k.split(".");
      return ` m${i}: metafield(namespace: "${namespace}", key: "${key}") { type value }`;
    })
    .join("");

// Each collection costs a result line, so only rules that name one read them.
const productQuery = (rules: Rules, keys: string[]) =>
  `{ products { edges { node { ${factFields(keys)}${namesCollection(rules) ? " collections { edges { node { id } } }" : ""} } } } }`;

// A list metafield compares item by item (§6).
const values = (m: Metafield) =>
  !m
    ? []
    : m.type.startsWith("list.")
      ? (JSON.parse(m.value) as unknown[]).map((v) =>
          typeof v === "string" ? v : JSON.stringify(v),
        )
      : [m.value];

// Unless the merchant caused the resolve, `auto: false` charts neither gain
// nor lose products (§6).
const manualCharts = (rules: Rules, merchant: boolean) =>
  new Set(merchant ? [] : rules.order.filter((id) => !rules.charts[id].auto));

// The chart a product moves to (null: none), or undefined when it stays.
// Comparing first is what stops Fitted's own writes from looping (§6).
function nextChart(
  n: ProductLine,
  collectionIds: string[],
  keys: string[],
  rules: Rules,
  active: ReadonlySet<string>,
  manual: ReadonlySet<string>,
) {
  const current = n.chart?.value ?? null;
  if (current && manual.has(current)) return undefined;
  const metafields = Object.fromEntries(
    keys.map((k, i) => [k, values(n[`m${i}`] as Metafield)]),
  );
  const { id, tags, productType, vendor } = n;
  const product = { id, tags, productType, vendor, collectionIds, metafields };
  const target = resolveChart(product, rules, active);
  return target === current ? undefined : target;
}
const assignment = (ownerId: string, value: string) => ({
  ownerId,
  ...CHART,
  type: "metaobject_reference",
  value,
});

// Fitted's Active charts, paged in id order so a chart saved meanwhile isn't
// skipped. A ranked id that isn't one (deleted, or another type) never matches.
// ponytail: reads every chart's content too; a status-only query if stores keep hundreds of charts.
async function activeCharts(admin: Admin) {
  const active = new Set<string>();
  for await (const charts of chartPages(admin))
    for (const c of charts) if (c.status === "ACTIVE") active.add(c.id);
  return active;
}

const POLL_MS = 3000;
// ponytail: waits at most 2 hours per bulk operation, plenty for six-figure catalogs.
const WAIT_MS = 2 * 60 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bulk files sit at signed URLs, so errors and logs never carry the URL: a
// failed fetch is reported by its error's name alone.
async function transfer(url: string, init?: RequestInit) {
  const signal = AbortSignal.timeout(300_000);
  const res = await fetch(url, { ...init, signal }).catch((e) => `${e?.name}`);
  if (typeof res !== "string" && res.ok) return res.text();
  const detail = typeof res === "string" ? res : `HTTP ${res.status}`;
  throw new AdminApiError("Shopify's bulk file didn't transfer", detail);
}

type Op = { status: string; errorCode: string | null; url: string | null };
// Starts a bulk operation, polls it, touching the job so it never looks
// stalled (§13), and returns its result lines.
// ponytail: holds the whole result in memory, fine to about 100,000 products; stream it past that.
async function bulk<T>(
  admin: Admin,
  start: string,
  variables: Record<string, unknown>,
  touch: Touch,
  retry = false,
): Promise<T[]> {
  type Started = Record<string, { bulkOperation: { id: string } }>;
  const started = await adminGraphql<Started>(admin, start, variables, {
    retry,
  });
  const id = Object.values(started)[0].bulkOperation.id;
  const end = Date.now() + WAIT_MS;
  for (;;) {
    const { bulkOperation: op } = await adminGraphql<{
      bulkOperation: Op | null;
    }>(
      admin,
      `#graphql
      query ResolveWait($id: ID!) { bulkOperation(id: $id) { status errorCode url } }`,
      { id },
      { retry: true },
    );
    if (op?.status === "COMPLETED")
      return op.url
        ? (await transfer(op.url))
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
    if (op?.status !== "CREATED" && op?.status !== "RUNNING")
      throw new AdminApiError(
        "Shopify's bulk operation didn't finish",
        `${op?.status ?? "MISSING"} ${op?.errorCode ?? ""}`,
      );
    if (Date.now() > end)
      throw new AdminApiError(
        "Shopify's bulk operation took too long",
        `${op.status} after ${WAIT_MS} ms`,
      );
    await touch();
    await sleep(POLL_MS);
  }
}

// Sent as data, the mutation each staged line runs.
const SET_CHARTS = `mutation ResolveSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { userErrors { field message code } }
}`;
type Answer = {
  __lineNumber?: number;
  errors?: unknown;
  data?: { metafieldsSet: { userErrors: unknown[] } | null };
};

// Returns how many Shopify refused. metafieldsSet is atomic, so a refused line
// leaves all of its products unchanged.
async function setCharts(
  admin: Admin,
  sets: Record<string, string>[],
  touch: Touch,
) {
  if (!sets.length) return { refused: 0, detail: "" };
  const lines: string[] = [];
  for (let i = 0; i < sets.length; i += 25)
    lines.push(JSON.stringify({ metafields: sets.slice(i, i + 25) }));
  type Target = { url: string; parameters: { name: string; value: string }[] };
  const { stagedUploadsCreate } = await adminGraphql<{
    stagedUploadsCreate: { stagedTargets: Target[] };
  }>(
    admin,
    `#graphql
    mutation ResolveStage {
      stagedUploadsCreate(input: [{ resource: BULK_MUTATION_VARIABLES, filename: "charts.jsonl", mimeType: "text/jsonl", httpMethod: POST }]) {
        stagedTargets { url parameters { name value } }
        userErrors { field message }
      }
    }`,
    {},
    { retry: true },
  );
  const [target] = stagedUploadsCreate.stagedTargets;
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  // The file goes last, after the fields that sign the upload.
  form.append("file", new Blob([lines.join("\n")], { type: "text/jsonl" }));
  await transfer(target.url, { method: "POST", body: form });
  const answers = await bulk<Answer>(
    admin,
    `#graphql
    mutation ResolveWrite($mutation: String!, $path: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) {
        bulkOperation { id }
        userErrors { field message code }
      }
    }`,
    {
      mutation: SET_CHARTS,
      path: target.parameters.find((p) => p.name === "key")?.value,
    },
    touch,
  );
  // An answer per line, numbered by __lineNumber; only a clean one counts as
  // set. The first refusal's text goes to the log (§15).
  const set = new Set<number>();
  let detail = "";
  answers.forEach((a, i) => {
    if (!a.errors && a.data?.metafieldsSet?.userErrors.length === 0)
      set.add(a.__lineNumber ?? i);
    else detail ||= JSON.stringify(a).slice(0, 500);
  });
  const refused = lines.reduce(
    (n, _, i) => (set.has(i) ? n : n + Math.min(25, sets.length - i * 25)),
    0,
  );
  return { refused, detail };
}

// metafieldsDelete answers a metafield that's already gone with null, so a
// retry is safe.
async function removeCharts(admin: Admin, ownerIds: string[], touch: Touch) {
  for (let i = 0; i < ownerIds.length; i += 25) {
    const metafields = ownerIds
      .slice(i, i + 25)
      .map((ownerId) => ({ ownerId, ...CHART }));
    await adminGraphql(
      admin,
      `#graphql
      mutation ResolveRemove($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) {
          deletedMetafields { ownerId }
          userErrors { field message }
        }
      }`,
      { metafields },
      { retry: true },
    );
    await touch();
  }
}

async function resolvePass(
  admin: Admin,
  shop: string,
  merchant: boolean,
  touch: Touch,
) {
  const startedAt = new Date();
  const { rules } = await getRules(admin);
  const active = await activeCharts(admin);
  const manual = manualCharts(rules, merchant);
  for (const id of manual) active.delete(id);
  const keys = comparedKeys(rules);
  // Starting a read twice only leaves a spare read running, so it may retry.
  const lines = await bulk<Line>(
    admin,
    `#graphql
    mutation ResolveRead($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id }
        userErrors { field message code }
      }
    }`,
    { query: productQuery(rules, keys) },
    touch,
    true,
  );
  // Each collection is its own line naming its product.
  const collections: Record<string, string[]> = {};
  for (const l of lines)
    if (l.__parentId) (collections[l.__parentId] ??= []).push(l.id);
  const sets: Record<string, string>[] = [];
  const removals: string[] = [];
  for (const l of lines) {
    if (l.__parentId) continue;
    const ids = collections[l.id] ?? [];
    const next = nextChart(l as ProductLine, ids, keys, rules, active, manual);
    if (next) sets.push(assignment(l.id, next));
    else if (next === null) removals.push(l.id);
  }
  const { refused, detail } = await setCharts(admin, sets, touch);
  await removeCharts(admin, removals, touch);
  // It read every product after startedAt and applied all it found, so a
  // webhook for an older edit can skip (§6).
  if (!refused)
    await db.shop.upsert({
      where: { shop },
      create: { shop, plan: "free", resolvedAt: startedAt }, // billing's first check sets the plan
      update: { resolvedAt: startedAt },
    });
  return { changed: sets.length - refused + removals.length, refused, detail };
}

// One resolve per shop at a time; asking while one runs makes it run once
// more when it finishes, as a merchant resolve if any ask was one.
// ponytail: in-process, so one app instance (§17); a queue before running two.
type Queued = {
  again: boolean | null;
  // Product deliveries that came while it ran: the newest updated_at of each.
  // ponytail: lost on a restart; mid-resolve the job's requeue (§13) reads
  // every product, and once it's done only the daily reconcile (§6) does.
  held: Map<string, Date>;
  done: Promise<void>;
};
const resolves = new Map<string, Queued>();

/**
 * Applies the rules to every product (§6). `merchant`: a rules save or a chart
 * published, unpublished or deleted, which also applies `auto: false` charts.
 * `shop` must come from an authenticated session or a verified webhook, and an
 * action checks canReadProducts first (§13). `attempt` counts the job checks'
 * requeues. Never rejects: a failure is logged and recorded on the job.
 */
export function startResolve(shop: string, merchant: boolean, attempt = 1) {
  const running = resolves.get(shop);
  if (running) {
    running.again = merchant || running.again === true;
    return running.done;
  }
  const entry: Queued = {
    again: null,
    held: new Map(),
    done: Promise.resolve(),
  };
  resolves.set(shop, entry);
  entry.done = (async () => {
    let clean = false;
    try {
      for (let next: boolean | null = merchant; next !== null;) {
        clean = await runResolve(shop, next, attempt);
        attempt = 1;
        next = entry.again;
        entry.again = null;
      }
    } finally {
      resolves.delete(shop);
    }
    // Held deliveries meet the skip now: the passes read most of them since,
    // the first pass's echoes included (§6).
    try {
      for (const [id, at] of entry.held) await productChanged(shop, id, at);
    } catch {
      // Logged already. They were answered, so Shopify won't send them again:
      // a full resolve reads the rest, another one after a clean resolve, and
      // after a failed one its requeue (§13).
      if (clean) void startResolve(shop, false);
    }
  })();
  return entry.done;
}

const log = (
  level: string,
  msg: string,
  shop: string | undefined,
  extra: object,
) =>
  console.log(JSON.stringify({ level, msg, shop, route: "resolve", ...extra }));

// The offline session, loaded for every call so a long job outlives its token (§3).
const offlineAdmin = (shop: string): Admin => ({
  graphql: async (query, options) =>
    (await unauthenticated.admin(shop)).admin.graphql(query, options),
});

// Whether the job finished.
async function runResolve(shop: string, merchant: boolean, attempt: number) {
  let id: string | undefined;
  try {
    const progress = { merchant, pass: 1, attempt };
    const data = { id: randomUUID(), shop, kind: "resolve", progress };
    ({ id } = await db.job.create({ data: { ...data, status: "running" } }));
    const admin = offlineAdmin(shop);
    let changed = 0;
    for (const pass of [1, 2]) {
      const touch = () =>
        db.job.update({
          where: { id, shop },
          data: { progress: { merchant, pass, attempt } },
        });
      await touch();
      const r = await resolvePass(admin, shop, merchant, touch);
      changed += r.changed;
      // The second pass redoes what the first couldn't set; refusals in it fail the job.
      const msg = `Shopify refused the chart for ${r.refused} products`;
      if (r.refused && pass === 2) throw new AdminApiError(msg, r.detail);
      if (r.refused) log("warn", msg, shop, { detail: r.detail });
    }
    const result = { changed };
    await db.job.update({
      where: { id, shop },
      data: { status: "done", result },
    });
    log("info", "Display rules applied", shop, result);
    return true;
  } catch (err) {
    const known =
      err instanceof AdminApiError || err instanceof StoredRulesError;
    log("error", "Display rules didn't finish applying", shop, {
      error: String(err),
      detail: err instanceof AdminApiError ? err.detail : undefined,
    });
    const error = known ? err.message : "Something went wrong";
    if (id)
      await db.job
        .update({ where: { id, shop }, data: { status: "failed", error } })
        .catch((e) =>
          log("error", "Resolve failure not recorded", shop, {
            error: String(e),
          }),
        );
    return false;
  }
}

// One product, for its webhook (§6): its facts, its chart and the status of
// every ranked chart in one query. A ranked id that isn't one of Fitted's
// charts never matches, as in the full resolve.
// ponytail: matches on a product's first 250 collections; the full resolve reads every one.
async function resolveOne(admin: Admin, shop: string, productId: string) {
  const { rules } = await getRules(admin);
  const keys = comparedKeys(rules);
  type Chart = {
    id?: string;
    type?: string;
    capabilities?: { publishable: { status: string } | null };
  } | null;
  const { product, charts, definition } = await adminGraphql<{
    product:
      (ProductLine & { collections?: { nodes: { id: string }[] } }) | null;
    charts: Chart[];
    definition: { type: string } | null;
  }>(
    admin,
    `query ResolveOne($id: ID!, $charts: [ID!]!) {
      product(id: $id) { ${factFields(keys)}${namesCollection(rules) ? " collections(first: 250) { nodes { id } }" : ""} }
      charts: nodes(ids: $charts) { ... on Metaobject { id type capabilities { publishable { status } } } }
      definition: metaobjectDefinitionByType(type: "$app:chart") { type }
    }`,
    { id: productId, charts: rules.order },
    { retry: true },
  );
  if (!product) return; // deleted since the delivery
  const manual = manualCharts(rules, false);
  const active = new Set(
    charts.flatMap((c) =>
      c?.id &&
      c.type === definition?.type &&
      c.capabilities?.publishable?.status === "ACTIVE" &&
      !manual.has(c.id)
        ? [c.id]
        : [],
    ),
  );
  const ids = product.collections?.nodes.map((c) => c.id) ?? [];
  const next = nextChart(product, ids, keys, rules, active, manual);
  if (next === undefined) return;
  if (next)
    await adminGraphql(
      admin,
      SET_CHARTS,
      { metafields: [assignment(productId, next)] },
      { retry: true },
    );
  else await removeCharts(admin, [productId], async () => {});
  log("info", next ? "Product chart set" : "Product chart removed", shop, {
    productId,
    chart: next ?? undefined,
  });
}

// Saved rules that fail validation leave a webhook nothing to apply; a valid
// save resolves every product (§6). Any other failure is logged and thrown.
async function webhookWork(
  shop: string,
  what: string,
  ids: object,
  work: () => Promise<void>,
) {
  try {
    await work();
  } catch (err) {
    if (err instanceof StoredRulesError)
      return log(
        "warn",
        `${what}: the saved display rules can't be read`,
        shop,
        ids,
      );
    log("error", `${what} didn't finish`, shop, {
      ...ids,
      error: String(err),
      detail: err instanceof AdminApiError ? err.detail : undefined,
    });
    throw err;
  }
}

/**
 * products/create and products/update (§6): resolves that product. While the
 * shop's full resolve runs, the delivery waits for it to finish; one older than
 * the shop's last clean pass is skipped, since that pass read the product after
 * it. `shop` comes from a verified webhook. Logs and throws a failure, so the
 * route answers 500 and Shopify retries.
 */
export async function productChanged(
  shop: string,
  productId: string,
  updatedAt: Date,
) {
  const running = resolves.get(shop);
  if (running) {
    const held = running.held.get(productId);
    if (!held || held < updatedAt) running.held.set(productId, updatedAt);
    return;
  }
  await webhookWork(shop, "Product chart", { productId }, async () => {
    const row = await db.shop.findUnique({
      where: { shop },
      select: { resolvedAt: true },
    });
    // updated_at has whole seconds: an edit just after a pass began can read as before it.
    const at = row?.resolvedAt?.getTime() ?? -Infinity;
    if (updatedAt.getTime() + 1000 <= at) return;
    await resolveOne(offlineAdmin(shop), shop, productId);
  });
}

/**
 * collections/update and collections/delete (§6): products joined or left it,
 * so a full resolve when a rule names it. Logs and throws a failure, like
 * productChanged.
 */
export async function collectionChanged(shop: string, collectionId: string) {
  await webhookWork(shop, "Collection check", { collectionId }, async () => {
    const { rules } = await getRules(offlineAdmin(shop));
    // ponytail: a full resolve per change to a named collection (its own
    // products would miss those that left); Events' collection.products
    // trigger names each product that joined or left, if catalogs feel it.
    if (
      conditions(rules).some(
        (c) => c.field === "collection" && c.ids.includes(collectionId),
      )
    )
      void startResolve(shop, false);
  });
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * For Home's loader (§6): a resolve when the shop's newest started over a day
 * ago, which catches webhooks Shopify never delivered. A failing shop tries
 * again the next day, not on every load. Never rejects.
 */
export async function resolveIfStale(shop: string) {
  try {
    const last = await db.job.findFirst({
      where: { shop, kind: "resolve" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    // A running resolve is fresh, even before its row is written.
    if (resolves.has(shop)) return;
    if (!last || Date.now() - last.createdAt.getTime() > DAY_MS)
      void startResolve(shop, false);
  } catch (err) {
    log("error", "Display rules check didn't start", shop, {
      error: String(err),
    });
  }
}

const STALL_MS = 10 * 60_000;
// A failed resolve is tried this many times in all, so a lasting failure stops.
const ATTEMPTS = 3;

/**
 * The job checks (§13): a job with no progress for 10 minutes fails, finished
 * jobs over 7 days old go except the newest of each shop and kind, and an
 * installed shop's failed resolve goes again as the same kind of resolve.
 * Settles when the resolves it requeued do; the next check never waits on it.
 */
export async function checkJobs() {
  // A job the old instance still runs during a deploy keeps touching its row.
  await db.job.updateMany({
    where: {
      status: "running",
      updatedAt: { lt: new Date(Date.now() - STALL_MS) },
    },
    data: { status: "failed", error: "The job stopped before it finished" },
  });
  // Prisma writes these columns in UTC. The newest finished job per shop and
  // kind stays: Home's setup guide reads it.
  await db.$executeRaw`
    DELETE FROM "Job" j
    WHERE j.status <> 'running'
      AND j."createdAt" < (now() AT TIME ZONE 'UTC') - interval '7 days'
      AND EXISTS (SELECT 1 FROM "Job" n
        WHERE n.shop = j.shop AND n.kind = j.kind AND n.status <> 'running'
          AND n."createdAt" > j."createdAt")`;
  // Each shop's newest resolve, when it failed. Only shops with an offline
  // session, so a resolve never brings back rows shop/redact deleted.
  const failed = await db.$queryRaw<{ shop: string; progress: unknown }[]>`
    SELECT j.shop, j.progress FROM "Job" j
    WHERE j.kind = 'resolve' AND j.status = 'failed'
      AND NOT EXISTS (SELECT 1 FROM "Job" n
        WHERE n.shop = j.shop AND n.kind = 'resolve' AND n."createdAt" > j."createdAt")
      AND EXISTS (SELECT 1 FROM "Session" s WHERE s.shop = j.shop AND NOT s."isOnline")`;
  await Promise.all(
    failed.map(({ shop, progress: p }) => {
      const attempt = isObj(p) && typeof p.attempt === "number" ? p.attempt : 1;
      const merchant = isObj(p) && p.merchant === true;
      // One still running here supersedes it; asking it to run again would
      // restart the count.
      return (
        attempt < ATTEMPTS &&
        !resolves.has(shop) &&
        startResolve(shop, merchant, attempt + 1)
      );
    }),
  );
}

declare global {
  // eslint-disable-next-line no-var
  var fittedJobChecks: ReturnType<typeof setInterval> | undefined;
}

/** Runs checkJobs at server start and every minute, once per process though dev reloads modules. */
export function startJobChecks() {
  if (globalThis.fittedJobChecks) return;
  const run = () =>
    checkJobs().catch((err) =>
      log("error", "Job checks didn't run", undefined, {
        route: "jobs",
        error: String(err),
      }),
    );
  void run();
  globalThis.fittedJobChecks = setInterval(run, 60_000).unref();
}
