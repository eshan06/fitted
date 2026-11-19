// Display rules (ARCHITECTURE §6): which chart each product shows. The rules
// live in the `$app.rules` shop metafield; resolveChart turns them into each
// product's `$app.chart` metafield, for one product from webhooks and for the
// whole catalog in a resolve job (§13).
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
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
// Keeps one product's resolve query under Shopify's query cost limit.
export const MAX_CHARTS = 200;

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
            (c, ci) => (ids += checkCondition(c, `${p}.${list}.${ci}`, fail)),
          );
      }
    }
  }
  if (ids > MAX_IDS)
    fail(
      "",
      `Rules can name at most ${MAX_IDS} products and collections. Use a tag or a collection for the rest.`,
    );
  if (Object.keys(errs).length) throw new RulesValidationError(errs);
  return input as Rules;
}

// Reports a bad condition's problems; returns how many ids it names.
function checkCondition(
  c: unknown,
  p: string,
  fail: (path: string, message: string) => void,
): number {
  const field = isObj(c) && typeof c.field === "string" ? c.field : "";
  if (!isObj(c) || !Object.hasOwn(FIELDS, field)) {
    fail(p, "Pick what the rule matches on");
    return 0;
  }
  const { keys, ops } = FIELDS[field];
  for (const k of Object.keys(c))
    if (k !== "field" && !keys.includes(k)) fail(`${p}.${k}`, "Unknown field");
  if (ops.length && !ops.includes(c.op as string))
    fail(`${p}.op`, "Pick how it compares");
  if (keys.includes("key") && (typeof c.key !== "string" || !KEY.test(c.key)))
    fail(`${p}.key`, "Use namespace.key, with letters, digits, - and _");
  if (
    keys.includes("value") &&
    (typeof c.value !== "string" || !c.value.trim() || c.value.length > 255)
  )
    fail(`${p}.value`, "Use 1 to 255 characters");
  if (!keys.includes("ids")) return 0;
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
const conditions = (rules: Rules) =>
  Object.values(rules.charts).flatMap((r) => [...r.match, ...r.exclude]);

export async function getRules(admin: Admin) {
  const { shop } = await adminGraphql<{
    shop: {
      id: string;
      rules: { jsonValue: unknown; compareDigest: string } | null;
    };
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
  // A stored value that fails validation throws, so a resolve stops instead of unassigning every product.
  const rules: Rules = shop.rules
    ? validateRules(shop.rules.jsonValue)
    : { v: 1, order: [], charts: {} };
  return { rules, digest: shop.rules?.compareDigest ?? null, shopId: shop.id };
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
  const stored = await getRules(admin);
  const paid: FieldErrors = Object.create(null);
  for (const [id, rule] of Object.entries(rules.charts))
    for (const list of ["match", "exclude"] as const)
      rule[list].forEach((c, i) => {
        if (
          !canUseRuleField(plan, c.field) &&
          !stored.rules.charts[id]?.[list].some((s) => isDeepStrictEqual(s, c))
        )
          paid[`charts.${id}.${list}.${i}`] =
            "Tag, type, vendor and metafield rules are on Standard and Pro";
      });
  if (Object.keys(paid).length) throw new RulesPlanError(paid);
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
            ownerId: stored.shopId,
            namespace: "$app",
            key: "rules",
            type: "json",
            value: JSON.stringify(rules),
            // never omitted: an omitted digest skips the check
            compareDigest: typeof digest === "string" ? digest : null,
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

// Resolving (§6). Rule metafields are read as aliases m0, m1, ... next to the
// product's own facts and its current chart.
const metafieldKeys = (rules: Rules) => [
  ...new Set(
    conditions(rules).flatMap((c) => (c.field === "metafield" ? [c.key] : [])),
  ),
];
const factFields = (keys: string[]) =>
  `id tags productType vendor chart: metafield(namespace: "$app", key: "chart") { value }` +
  keys
    .map((k, i) => {
      const [namespace, key] = k.split(".");
      return ` m${i}: metafield(namespace: "${namespace}", key: "${key}") { type value }`;
    })
    .join("");
type Metafield = { type: string; value: string } | null | undefined;
type Node = {
  id: string;
  tags: string[];
  productType: string;
  vendor: string;
  chart: { value: string } | null;
  [alias: string]: unknown;
};
function toProduct(n: Node, keys: string[], collectionIds: string[]) {
  const values = (m: Metafield) => {
    if (!m) return [];
    if (!m.type.startsWith("list.")) return [m.value];
    const list: unknown[] = JSON.parse(m.value);
    return list.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
  };
  const metafields = Object.fromEntries(
    keys.map((k, i) => [k, values(n[`m${i}`] as Metafield)]),
  );
  const { id, tags, productType, vendor } = n;
  return { id, tags, productType, vendor, collectionIds, metafields };
}

const CHART_STATE = `charts: nodes(ids: $charts) {
    ... on Metaobject { id type capabilities { publishable { status } } }
  }
  definition: metaobjectDefinitionByType(type: "$app:chart") { type }`;
type ChartState = {
  charts: ({
    id?: string;
    type?: string;
    capabilities?: { publishable: { status: string } | null };
  } | null)[];
  definition: { type: string } | null;
};
// The charts a resolve may assign, and those it must leave alone: unless the
// merchant caused it, `auto: false` charts neither gain nor lose products.
function chartSets(rules: Rules, state: ChartState, merchant: boolean) {
  const type = state.definition?.type;
  if (!type) throw new Error("The size chart definition is missing");
  const manual = new Set(rules.order.filter((id) => !rules.charts[id].auto));
  const active = new Set(
    state.charts.flatMap((n) =>
      n?.id &&
      n.type === type &&
      n.capabilities?.publishable?.status === "ACTIVE" &&
      (merchant || !manual.has(n.id))
        ? [n.id]
        : [],
    ),
  );
  return { active, leave: merchant ? new Set<string>() : manual };
}

const SET_CHARTS = `#graphql
  mutation SetCharts($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }`;
const assignment = (ownerId: string, chart: string) => ({
  ownerId,
  namespace: "$app",
  key: "chart",
  type: "metaobject_reference",
  value: chart,
});
async function removeCharts(admin: Admin, ownerIds: string[]) {
  for (let i = 0; i < ownerIds.length; i += 25)
    await adminGraphql(
      admin,
      `#graphql
      mutation RemoveCharts($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) {
          deletedMetafields { ownerId }
          userErrors { field message }
        }
      }`,
      {
        metafields: ownerIds
          .slice(i, i + 25)
          .map((ownerId) => ({ ownerId, namespace: "$app", key: "chart" })),
      },
      { retry: true },
    );
}

/**
 * products/create and products/update: resolve one product. A delivery whose
 * `updatedAt` is older than the shop's latest resolve pass is skipped, since
 * that pass read the product afterwards. Returns whether it wrote.
 */
export async function resolveProduct(
  admin: Admin,
  shop: string,
  productId: string,
  updatedAt?: string,
) {
  const row = await db.shop.findUnique({ where: { shop } });
  if (updatedAt && row?.resolvedAt && new Date(updatedAt) < row.resolvedAt)
    return false;
  const { rules } = await getRules(admin);
  const keys = metafieldKeys(rules);
  const named = conditions(rules).some((c) => c.field === "collection");
  const data = await adminGraphql<
    ChartState & {
      product: (Node & { collections?: { nodes: { id: string }[] } }) | null;
    }
  >(
    admin,
    `#graphql
    query RuleProduct($id: ID!, $charts: [ID!]!) {
      product(id: $id) {
        ${factFields(keys)}
        ${named ? "collections(first: 250) { nodes { id } }" : ""}
      }
      ${CHART_STATE}
    }`,
    { id: productId, charts: rules.order },
    { retry: true },
  );
  const { active, leave } = chartSets(rules, data, false);
  const current = data.product?.chart?.value ?? null;
  if (!data.product || (current && leave.has(current))) return false;
  // ponytail: a product in more than 250 collections matches on its first 250; page them if that bites.
  const collectionIds = data.product.collections?.nodes.map((c) => c.id) ?? [];
  const target = resolveChart(
    toProduct(data.product, keys, collectionIds),
    rules,
    active,
  );
  if (target === current) return false;
  if (target)
    await adminGraphql(
      admin,
      SET_CHARTS,
      { metafields: [assignment(productId, target)] },
      { retry: true },
    );
  else await removeCharts(admin, [productId]);
  return true;
}

/** collections/update and collections/delete: a full resolve when a rule names the collection. */
export async function resolveCollection(
  admin: Admin,
  shop: string,
  collectionId: string,
) {
  const { rules } = await getRules(admin);
  const named = conditions(rules).some(
    (c) => c.field === "collection" && c.ids.includes(collectionId),
  );
  // ponytail: resolves the whole catalog; resolve only the collection's products if big catalogs feel it.
  if (named) void startResolve(shop);
  return named;
}

// Bulk operations (§6): poll until done, then read the result lines.
const POLL_MS = 2000;
const TRANSFER_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function transfer(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TRANSFER_MS),
  });
  if (!res.ok) throw new Error(`Bulk file transfer failed: ${res.status}`);
  return res.text();
}
type Line = Record<string, unknown> & { id: string; __parentId?: string };
async function bulkLines(
  admin: Admin,
  id: string,
  onPoll: () => Promise<unknown>,
): Promise<Line[]> {
  for (;;) {
    await sleep(POLL_MS);
    const { bulkOperation: op } = await adminGraphql<{
      bulkOperation: { status: string; errorCode: string | null; url: string };
    }>(
      admin,
      `#graphql
      query BulkStatus($id: ID!) {
        bulkOperation(id: $id) { status errorCode url }
      }`,
      { id },
      { retry: true },
    );
    if (op.status === "COMPLETED")
      return op.url
        ? (await transfer(op.url))
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
    if (op.status !== "CREATED" && op.status !== "RUNNING")
      throw new Error(`Bulk operation ${op.status} ${op.errorCode ?? ""}`);
    await onPoll();
  }
}

// ponytail: one staged file holds up to 20 MB, about 130,000 products; split it past that.
async function bulkAssign(
  admin: Admin,
  sets: ReturnType<typeof assignment>[],
  onPoll: () => Promise<unknown>,
) {
  if (!sets.length) return;
  const lines: string[] = [];
  for (let i = 0; i < sets.length; i += 25)
    lines.push(JSON.stringify({ metafields: sets.slice(i, i + 25) }));
  const { stagedUploadsCreate } = await adminGraphql<{
    stagedUploadsCreate: {
      stagedTargets: {
        url: string;
        parameters: { name: string; value: string }[];
      }[];
    };
  }>(
    admin,
    `#graphql
    mutation StageAssignments {
      stagedUploadsCreate(input: [{ resource: BULK_MUTATION_VARIABLES, filename: "chart-assignments.jsonl", mimeType: "text/jsonl", httpMethod: POST }]) {
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
  // Shopify needs the file last.
  form.append("file", new Blob([lines.join("\n")], { type: "text/jsonl" }));
  await transfer(target.url, { method: "POST", body: form });
  const { bulkOperationRunMutation } = await adminGraphql<{
    bulkOperationRunMutation: { bulkOperation: { id: string } };
  }>(
    admin,
    `#graphql
    mutation RunAssignments($mutation: String!, $path: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) {
        bulkOperation { id }
        userErrors { field message code }
      }
    }`,
    {
      mutation: SET_CHARTS,
      path: target.parameters.find((p) => p.name === "key")?.value,
    },
  );
  const refused = (
    await bulkLines(admin, bulkOperationRunMutation.bulkOperation.id, onPoll)
  ).filter((r) => {
    const data = r.data as { metafieldsSet?: { userErrors: unknown[] } };
    return r.errors || data?.metafieldsSet?.userErrors.length;
  });
  if (refused.length)
    throw new Error(
      `Shopify refused ${refused.length} of ${lines.length} assignment batches: ${JSON.stringify(refused[0]).slice(0, 500)}`,
    );
}

// One pass over every product; returns how many changed chart.
async function resolvePass(
  admin: Admin,
  shop: string,
  merchant: boolean,
  onPoll: () => Promise<unknown>,
) {
  const startedAt = new Date();
  const { rules } = await getRules(admin);
  const state = await adminGraphql<ChartState>(
    admin,
    `#graphql
    query RuleCharts($charts: [ID!]!) {
      ${CHART_STATE}
    }`,
    { charts: rules.order },
    { retry: true },
  );
  const { active, leave } = chartSets(rules, state, merchant);
  const keys = metafieldKeys(rules);
  const named = conditions(rules).some((c) => c.field === "collection");
  const { bulkOperationRunQuery } = await adminGraphql<{
    bulkOperationRunQuery: { bulkOperation: { id: string } };
  }>(
    admin,
    `#graphql
    mutation ReadProducts($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id }
        userErrors { field message code }
      }
    }`,
    {
      query: `{ products { edges { node { ${factFields(keys)} ${named ? "collections { edges { node { id } } }" : ""} } } } }`,
    },
  );
  const lines = await bulkLines(
    admin,
    bulkOperationRunQuery.bulkOperation.id,
    onPoll,
  );
  // Each collection is its own line, naming its product.
  const collections = new Map<string, string[]>();
  for (const l of lines)
    if (l.__parentId) {
      const ids = collections.get(l.__parentId) ?? [];
      collections.set(l.__parentId, ids);
      ids.push(l.id);
    }
  // This pass read every product after startedAt (the webhooks' skip rule).
  // A new row's plan stays Free until billing's first check (§8).
  await db.shop.upsert({
    where: { shop },
    create: { shop, plan: "free", resolvedAt: startedAt },
    update: { resolvedAt: startedAt },
  });
  const sets: ReturnType<typeof assignment>[] = [];
  const removals: string[] = [];
  for (const l of lines) {
    if (l.__parentId) continue;
    const n = l as unknown as Node;
    const current = n.chart?.value ?? null;
    if (current && leave.has(current)) continue;
    const product = toProduct(n, keys, collections.get(n.id) ?? []);
    const target = resolveChart(product, rules, active);
    if (target === current) continue;
    if (target) sets.push(assignment(n.id, target));
    else removals.push(n.id);
  }
  await bulkAssign(admin, sets, onPoll);
  await removeCharts(admin, removals);
  return sets.length + removals.length;
}

// Resolve jobs (§13). One per shop at a time in this process; asking while
// one runs makes it run once more when it finishes. ponytail: in-process, one
// instance (§17); move to a queue before running two.
const RETRIES = 2; // a failed resolve is requeued at most this many times
type Progress = { merchant: boolean; attempt: number; pass?: number };
const queue = new Map<string, { again: boolean | null; done: Promise<void> }>();

/** A §15 JSON log line; Shopify's raw text goes in `detail`, never to a screen. */
export const logError = (
  shop: string,
  route: string,
  msg: string,
  err: unknown,
) =>
  console.log(
    JSON.stringify({
      level: "error",
      msg,
      shop,
      route,
      error: String(err),
      detail: err instanceof AdminApiError ? err.detail : undefined,
    }),
  );

/**
 * Resolves every product. `merchant`: a rules save or a chart published,
 * unpublished or deleted, so `auto: false` charts apply too (§6). Never
 * rejects: a failure is recorded on the job.
 */
export function startResolve(shop: string, merchant = false, attempt = 1) {
  const busy = queue.get(shop);
  if (busy) {
    busy.again = merchant || !!busy.again;
    return busy.done;
  }
  const entry = { again: null as boolean | null, done: Promise.resolve() };
  queue.set(shop, entry);
  entry.done = (async () => {
    for (let run: Progress | null = { merchant, attempt }; run;) {
      await runJob(shop, run);
      run = entry.again === null ? null : { merchant: entry.again, attempt: 1 };
      entry.again = null;
    }
    queue.delete(shop);
  })();
  return entry.done;
}

async function runJob(shop: string, progress: Progress) {
  let id: string | undefined;
  try {
    ({ id } = await db.job.create({
      data: {
        id: randomUUID(),
        shop,
        kind: "resolve",
        status: "running",
        progress,
      },
    }));
    const { admin } = await unauthenticated.admin(shop);
    let changed = 0;
    // The second pass covers products edited while the first ran (§6).
    for (const pass of [1, 2]) {
      const touch = () =>
        db.job.update({
          where: { id },
          data: { progress: { ...progress, pass } },
        });
      await touch();
      changed += await resolvePass(admin, shop, progress.merchant, touch);
    }
    await db.job.update({
      where: { id },
      data: { status: "done", result: { changed } },
    });
  } catch (err) {
    logError(shop, "rules", "Resolve failed", err);
    if (id)
      await db.job
        .update({
          where: { id },
          data: {
            status: "failed",
            error: "The display rules didn't finish applying",
          },
        })
        .catch((e) => logError(shop, "rules", "Resolve not recorded", e));
  }
}

const DAY_MS = 24 * 60 * 60_000;
/** For Home's loader: a resolve when the shop's last one is a day old, catching missed webhooks. */
export async function resolveIfStale(shop: string) {
  if (queue.has(shop)) return;
  const row = await db.shop.findUnique({ where: { shop } });
  if (!row?.resolvedAt || Date.now() - row.resolvedAt.getTime() > DAY_MS)
    void startResolve(shop);
}

/** Every minute and at server start: stalled jobs fail, failed resolves go again, old jobs go (§13). */
export async function checkJobs() {
  const now = Date.now();
  await db.job.updateMany({
    where: {
      status: "running",
      updatedAt: { lt: new Date(now - 10 * 60_000) },
    },
    data: { status: "failed", error: "The job stopped" },
  });
  const failed = await db.$queryRaw<{ shop: string; progress: Progress }[]>`
    SELECT shop, progress FROM (
      SELECT DISTINCT ON (shop) shop, status, progress FROM "Job"
      WHERE kind = 'resolve' ORDER BY shop, "createdAt" DESC
    ) newest WHERE status = 'failed'`;
  for (const { shop, progress } of failed)
    if (progress.attempt <= RETRIES)
      void startResolve(shop, progress.merchant, progress.attempt + 1);
  // The newest finished job per shop and kind stays (Home's setup guide reads it).
  await db.$executeRaw`
    DELETE FROM "Job" j WHERE j.status <> 'running' AND j."createdAt" < ${new Date(now - 7 * DAY_MS)}
    AND EXISTS (SELECT 1 FROM "Job" n WHERE n.shop = j.shop AND n.kind = j.kind
      AND n.status <> 'running' AND n."createdAt" > j."createdAt")`;
}

declare global {
  // eslint-disable-next-line no-var
  var fittedJobChecks: ReturnType<typeof setInterval> | undefined;
}
export function startJobChecks() {
  const run = () =>
    checkJobs().catch((err) => logError("", "jobs", "Job check failed", err));
  if (globalThis.fittedJobChecks) return;
  void run();
  globalThis.fittedJobChecks = setInterval(run, 60_000);
}
