import type { Shop } from "@prisma/client";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";

// Plans and gating, ARCHITECTURE §8. The plan comes from Shopify App Pricing
// through the Partner API, is cached on the Shop row, and is copied to the
// `$app.plan` shop metafield for the storefront after every confirmed read.

const PLANS = ["free", "standard", "pro"] as const;
export type Plan = (typeof PLANS)[number];
/** `checkFailed`: the plan couldn't be confirmed, so `plan` is the last confirmed one (Free if none). */
export type PlanState = { plan: Plan; checkFailed: boolean };

// Gates block new actions only: nothing already live is taken down after a downgrade.
export const FREE_ACTIVE_CHARTS = 3;
/** `activeCharts`: how many charts are Active now, not counting the one being published. */
export const canPublishChart = (plan: Plan, activeCharts: number) =>
  plan !== "free" || activeCharts < FREE_ACTIVE_CHARTS;
const FREE_RULE_FIELDS = ["all", "product", "collection"];
/** `field`: a display rule condition's field (§6). */
export const canUseRuleField = (plan: Plan, field: string) =>
  plan !== "free" || FREE_RULE_FIELDS.includes(field);
export const canShowFitFinder = (plan: Plan) => plan === "pro";
export const canUseTranslationTools = (plan: Plan) => plan === "pro";
export const canShowFitFinderStats = (plan: Plan) => plan === "pro";

const FRESH_MS = 5 * 60_000; // a confirmed plan is re-checked after this
const GAP_MS = 10_000; // between the starts of one shop's checks, failed or not
const BACKOFF_MS = 2_000; // every shop waits this long after a 429: the Partner API's limit is shared
const PARTNER_API_VERSION = "2026-07";

type Check = { startedAt: number; done: boolean; result: Promise<PlanState> };
// One app instance (§17), so the throttle lives in memory.
// ponytail: one entry per shop that ever opened Fitted; prune old entries if that reaches the millions.
const lastCheck = new Map<string, Check>();
let backoffUntil = 0;

/**
 * The shop's plan for gating. `shop` must come from an authenticated session.
 * `recheck` (the welcome link's `plan_handle`) skips the cache; inside the gap
 * after the shop's last check it waits for the gap, never skipping the check.
 */
export async function getPlan(
  shop: string,
  { recheck = false } = {},
): Promise<PlanState> {
  const row = recheck ? null : await db.shop.findUnique({ where: { shop } });
  // No await from here on, so two calls can't both start a check.
  const last = lastCheck.get(shop);
  // Join a check in flight. A re-check joins only one that hasn't started, so its read comes after the request.
  if (last && !last.done && (!recheck || last.startedAt === Infinity))
    return last.result;
  if (row?.planCheckedAt && Date.now() - row.planCheckedAt.getTime() < FRESH_MS)
    return { plan: toPlan(row.plan), checkFailed: false };
  if (!recheck && last && Date.now() - last.startedAt < GAP_MS)
    return last.result;

  const next = { startedAt: Infinity, done: false } as Check;
  next.result = (async () => {
    if (last) await last.result; // one check per shop at a time, so an older read never lands last
    const wait = () =>
      Math.max((last?.startedAt ?? 0) + GAP_MS, backoffUntil) - Date.now();
    while (wait() > 0) await sleep(wait()); // a 429 can land while this waits
    next.startedAt = Date.now();
    try {
      return await check(shop);
    } finally {
      next.done = true;
    }
  })();
  lastCheck.set(shop, next);
  return next.result;
}

async function check(shop: string): Promise<PlanState> {
  let row: Shop | null = null;
  try {
    row = await db.shop.findUnique({ where: { shop } });
    // The offline session: a staff member's own access may not allow the metafield write.
    const { admin } = await unauthenticated.admin(shop);
    const shopId = await readShopId(admin);
    const plan = await fetchPlan(shopId);
    if (plan !== row?.planOnStore) await writeStorePlan(admin, shopId, plan);
    const data = { plan, planCheckedAt: new Date(), planOnStore: plan };
    await db.shop.upsert({
      where: { shop },
      create: { shop, ...data },
      update: data,
    });
    return { plan, checkFailed: false };
  } catch (error) {
    // A failed check changes nothing, in the app or on the storefront.
    console.log(
      JSON.stringify({
        level: "error",
        msg: "Plan check failed",
        shop,
        route: "billing",
        error: String(error),
      }),
    );
    return { plan: toPlan(row?.plan), checkFailed: true };
  }
}

type Admin = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

async function readShopId(admin: Admin): Promise<string> {
  const response = await admin.graphql(`#graphql
    query ShopId {
      shop {
        id
      }
    }`);
  const body = await response.json();
  const id = body.data?.shop?.id;
  if (typeof id !== "string") throw new Error("Admin API returned no shop id");
  return id;
}

const ACTIVE_SUBSCRIPTION = `query ActiveSubscription($appId: ID!, $shopId: ID!) {
  activeSubscription(appId: $appId, shopId: $shopId) {
    items {
      handle
    }
  }
}`;

async function fetchPlan(shopId: string): Promise<Plan> {
  const org = process.env.SHOPIFY_PARTNER_ORG_ID;
  const token = process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN;
  const appId = process.env.SHOPIFY_APP_GID;
  if (!org || !token || !appId)
    throw new Error("The Partner API env vars aren't set");
  const response = await fetch(
    `https://partners.shopify.com/${org}/api/${PARTNER_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: ACTIVE_SUBSCRIPTION,
        variables: { appId, shopId },
      }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  const body = await response.json().catch(() => null);
  const errors = body?.errors;
  if (
    response.status === 429 ||
    (Array.isArray(errors) &&
      errors.some(
        (e: { extensions?: { code?: string } }) =>
          e?.extensions?.code === "429",
      ))
  ) {
    backoffUntil = Date.now() + BACKOFF_MS;
    throw new Error("Partner API throttled the plan check");
  }
  if (!response.ok || errors)
    throw new Error(
      `Partner API returned ${response.status}: ${JSON.stringify(errors ?? null)}`,
    );
  const subscription = body?.data?.activeSubscription;
  if (subscription === null) return "free"; // no subscription
  if (!Array.isArray(subscription?.items))
    throw new Error("Partner API returned no subscription items");
  const handles = subscription.items.map(
    (item: { handle?: unknown }) => item?.handle,
  );
  // A missing or unknown handle is Free.
  if (handles.includes("pro")) return "pro";
  if (handles.includes("standard")) return "standard";
  return "free";
}

async function writeStorePlan(admin: Admin, shopId: string, plan: Plan) {
  const response = await admin.graphql(
    `#graphql
    mutation SetStorePlan($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopId,
            namespace: "$app",
            key: "plan",
            type: "single_line_text_field",
            value: plan,
          },
        ],
      },
    },
  );
  const body = await response.json();
  const userErrors = body.data?.metafieldsSet?.userErrors;
  if (!Array.isArray(userErrors) || userErrors.length)
    throw new Error(`metafieldsSet failed: ${JSON.stringify(userErrors)}`);
}

const toPlan = (value: unknown): Plan =>
  PLANS.includes(value as Plan) ? (value as Plan) : "free";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
