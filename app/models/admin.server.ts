// The one way models call the Admin API (ARCHITECTURE §15): throws on GraphQL
// errors and on userErrors, and retries only when the caller says the
// operation is safe to repeat.
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export type Admin = Pick<AdminApiContext, "graphql">;
export type UserError = {
  field?: string[] | null;
  message: string;
  code?: string | null;
};

// A failed Shopify call. Routes answer 502 and log `detail`, Shopify's raw
// text, as a §15 JSON line with their shop and route; it is never shown.
export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly detail: string,
    readonly userErrors: UserError[] = [],
  ) {
    super(message);
  }
}

const BACKOFF_MS = [500, 1500];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The library throws a Response to re-authenticate (401, or a redirect to its
// bounce page) and also for any other HTTP error Shopify answers. Only re-auth
// is the library's to handle; the rest is a failed call like any other (§15).
const reauth = (err: unknown): err is Response =>
  err instanceof Response &&
  (err.status === 401 || (err.status >= 300 && err.status < 400));
const failed = (err: unknown) =>
  new AdminApiError(
    "Shopify request failed",
    err instanceof Response ? `HTTP ${err.status}` : String(err),
  );

export async function adminGraphql<T>(
  admin: Admin,
  query: string,
  variables: Record<string, unknown> = {},
  { retry = false }: { retry?: boolean } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let body: { data?: Record<string, unknown>; errors?: unknown };
    try {
      body = await (await admin.graphql(query, { variables })).json();
      if (body.errors || !body.data)
        throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
    } catch (err) {
      if (reauth(err)) throw err;
      if (retry && attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      throw failed(err);
    }
    const userErrors = Object.values(body.data).flatMap((v) =>
      v &&
      typeof v === "object" &&
      Array.isArray((v as { userErrors?: unknown }).userErrors)
        ? (v as { userErrors: UserError[] }).userErrors
        : [],
    );
    if (userErrors.length)
      throw new AdminApiError(
        "Shopify refused the change",
        JSON.stringify(userErrors),
        userErrors,
      );
    return body.data as T;
  }
}

type GraphqlError = { extensions?: { code?: string } } | null;
/**
 * Whether the session's staff member can read products. Jobs run with the
 * offline token, so an action checks this before it starts one (§13). An
 * online token narrowed by the staff member's permissions gets ACCESS_DENIED.
 */
export async function canReadProducts(admin: Admin) {
  let errors: unknown;
  try {
    const body: { data?: { products?: unknown }; errors?: unknown } = await (
      await admin.graphql(`#graphql
        query FittedProductAccess { products(first: 1) { nodes { id } } }`)
    ).json();
    if (body.data?.products) return true;
    errors = body.errors;
  } catch (err) {
    if (reauth(err)) throw err;
    // The client throws its GraphqlQueryError with the GraphQL errors on it.
    errors = (err as { body?: { errors?: { graphQLErrors?: unknown } } })?.body
      ?.errors?.graphQLErrors;
    if (!errors) throw failed(err);
  }
  const denied = (e: GraphqlError) => e?.extensions?.code === "ACCESS_DENIED";
  if (Array.isArray(errors) && errors.some(denied)) return false;
  throw new AdminApiError(
    "Shopify request failed",
    JSON.stringify(errors ?? null),
  );
}

/** Shopify's plan selection page for this app (§8); open it with target="_top". */
export async function pricingPlansUrl(admin: Admin, shop: string) {
  const data = await adminGraphql<{
    currentAppInstallation: { app: { handle: string } };
  }>(
    admin,
    `#graphql
    query FittedAppHandle { currentAppInstallation { app { handle } } }`,
    {},
    { retry: true },
  );
  const store = shop.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${store}/charges/${data.currentAppInstallation.app.handle}/pricing_plans`;
}
