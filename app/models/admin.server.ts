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

// A failed Shopify call: routes answer 502 and log, never show, the message.
export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly userErrors: UserError[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const BACKOFF_MS = [500, 1500];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      // A thrown Response is the library asking for re-auth: pass it through.
      if (err instanceof Response) throw err;
      if (retry && attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      console.error("Admin API request failed", err);
      throw new AdminApiError("Shopify request failed", [], { cause: err });
    }
    const userErrors = Object.values(body.data).flatMap((v) =>
      v &&
      typeof v === "object" &&
      Array.isArray((v as { userErrors?: unknown }).userErrors)
        ? (v as { userErrors: UserError[] }).userErrors
        : [],
    );
    if (userErrors.length) {
      console.error("Admin API user errors", userErrors);
      throw new AdminApiError("Shopify refused the change", userErrors);
    }
    return body.data as T;
  }
}
