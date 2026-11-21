import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Admin,
  AccessDeniedError,
  AdminApiError,
  adminGraphql,
  canReadProducts,
  pricingPlansUrl,
  streamed,
} from "./admin.server";

const ok = (body: unknown) => new Response(JSON.stringify(body));
// An admin whose graphql answers each call with the next step in turn.
function adminWith(...steps: (unknown | Error | Response)[]) {
  const graphql = vi.fn(async () => {
    const step = steps.shift();
    if (step instanceof Error || step instanceof Response) throw step;
    return ok(step);
  });
  return { admin: { graphql } as unknown as Admin, graphql };
}
// Runs the call to completion, fast-forwarding the retry backoff.
async function run<T>(p: Promise<T>) {
  const settled = p.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return settled as Promise<{ value?: T; error?: unknown }>;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("adminGraphql", () => {
  it("leaves logging to the caller, who knows the shop and route (§15)", async () => {
    const logs = (["log", "error", "warn"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {}),
    );
    const failed = adminWith(new Error("socket hang up"));
    const e1 = (await run(adminGraphql(failed.admin, "q"))).error;
    const refused = adminWith({
      data: { m: { userErrors: [{ message: "Value is bad" }] } },
    });
    const e2 = (await run(adminGraphql(refused.admin, "m"))).error;
    expect((e1 as AdminApiError).detail).toContain("socket hang up");
    expect((e2 as AdminApiError).detail).toContain("Value is bad");
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("returns data and sends the variables", async () => {
    const { admin, graphql } = adminWith({ data: { shop: { name: "A" } } });
    const r = await run(
      adminGraphql(admin, "query Q { shop { name } }", { a: 1 }),
    );
    expect(r.value).toEqual({ shop: { name: "A" } });
    expect(graphql).toHaveBeenCalledWith("query Q { shop { name } }", {
      variables: { a: 1 },
    });
  });

  it("throws on userErrors and never retries them", async () => {
    const userErrors = [{ field: ["id"], message: "Nope", code: "INVALID" }];
    const { admin, graphql } = adminWith({
      data: { metaobjectDelete: { deletedId: null, userErrors } },
    });
    const r = await run(adminGraphql(admin, "m", {}, { retry: true }));
    expect(r.error).toBeInstanceOf(AdminApiError);
    expect((r.error as AdminApiError).userErrors).toEqual(userErrors);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("passes empty userErrors through as success", async () => {
    const data = { metaobjectDelete: { deletedId: "x", userErrors: [] } };
    const { admin } = adminWith({ data });
    expect((await run(adminGraphql(admin, "m"))).value).toEqual(data);
  });

  it("retries a failed read twice, then succeeds", async () => {
    const { admin, graphql } = adminWith(
      new Error("socket hang up"),
      { errors: [{ message: "Throttled" }] },
      { data: { ok: true } },
    );
    const r = await run(adminGraphql(admin, "q", {}, { retry: true }));
    expect(r.value).toEqual({ ok: true });
    expect(graphql).toHaveBeenCalledTimes(3);
  });

  it("gives up after three attempts with an AdminApiError", async () => {
    const { admin, graphql } = adminWith(
      new Error("1"),
      new Error("2"),
      new Error("3"),
      { data: {} },
    );
    const r = await run(adminGraphql(admin, "q", {}, { retry: true }));
    expect(r.error).toBeInstanceOf(AdminApiError);
    expect(graphql).toHaveBeenCalledTimes(3);
  });

  it("does not retry a write unless asked", async () => {
    const { admin, graphql } = adminWith(new Error("timeout"), { data: {} });
    const r = await run(adminGraphql(admin, "m"));
    expect(r.error).toBeInstanceOf(AdminApiError);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("treats GraphQL errors and missing data as failures", async () => {
    for (const body of [{ errors: [{ message: "Bad" }], data: null }, {}]) {
      const { admin } = adminWith(body);
      expect((await run(adminGraphql(admin, "q"))).error).toBeInstanceOf(
        AdminApiError,
      );
    }
  });

  it("rethrows a thrown Response (re-auth) untouched, without retrying", async () => {
    const bounce = {
      status: 302,
      headers: { Location: "/auth/session-token" },
    };
    for (const reauth of [
      new Response(null, { status: 401 }),
      new Response(null, bounce),
    ]) {
      const { admin, graphql } = adminWith(reauth, { data: {} });
      const r = await run(adminGraphql(admin, "q", {}, { retry: true }));
      expect(r.error).toBe(reauth);
      expect(graphql).toHaveBeenCalledTimes(1);
    }
  });

  it("treats any other thrown Response, Shopify's HTTP error, as a failed call (§15)", async () => {
    const down = () => new Response("Service Unavailable", { status: 503 });
    const retried = adminWith(down(), { data: { ok: true } });
    const r1 = await run(adminGraphql(retried.admin, "q", {}, { retry: true }));
    expect(r1.value).toEqual({ ok: true });
    expect(retried.graphql).toHaveBeenCalledTimes(2);
    const r2 = await run(adminGraphql(adminWith(down()).admin, "q"));
    expect(r2.error).toBeInstanceOf(AdminApiError);
    expect((r2.error as AdminApiError).detail).toBe("HTTP 503");
  });

  it("never puts Shopify's raw text in its message", async () => {
    const { admin } = adminWith(new Error("secret internal detail"));
    const r = await run(adminGraphql(admin, "q"));
    expect((r.error as Error).message).not.toContain("secret");
  });

  it("names a staff member Shopify refuses, and never retries the refusal (§15)", async () => {
    const denied = {
      message: "Access denied for productsCount field.",
      extensions: { code: "ACCESS_DENIED" },
    };
    // How the client throws it, the body as some answer it, and an HTTP 403.
    const thrown = Object.assign(new Error("GraphQL Client: denied"), {
      body: { errors: { graphQLErrors: [denied] } },
    });
    for (const [step, raw] of [
      [thrown, "GraphQL Client: denied"],
      [{ data: null, errors: [denied] }, "Access denied for productsCount"],
      [new Response(null, { status: 403 }), "HTTP 403"],
    ] as const) {
      const { admin, graphql } = adminWith(step, { data: { ok: true } });
      const r = await run(adminGraphql(admin, "q", {}, { retry: true }));
      expect(r.error).toBeInstanceOf(AccessDeniedError);
      // Every route that treats a failed call alike still catches it.
      expect(r.error).toBeInstanceOf(AdminApiError);
      expect((r.error as AdminApiError).detail).toContain(raw);
      // A resolve job shows it as its reason, so it's plain and names no one.
      expect((r.error as Error).message).toBe("Shopify refused access");
      expect(graphql).toHaveBeenCalledTimes(1);
    }
  });
});

describe("canReadProducts", () => {
  const denied = {
    message: "Access denied for products field.",
    extensions: { code: "ACCESS_DENIED" },
  };
  // How the Shopify client throws a response with GraphQL errors.
  const queryError = (...graphQLErrors: unknown[]) =>
    Object.assign(new Error("GraphQL Client: An error occurred"), {
      body: { errors: { graphQLErrors } },
    });

  it("is true when the session's token reads products", async () => {
    const { admin, graphql } = adminWith({ data: { products: { nodes: [] } } });
    expect(await canReadProducts(admin)).toBe(true);
    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining("products(first: 1)"),
    );
  });

  it("is false when Shopify denies the staff member's token products", async () => {
    expect(await canReadProducts(adminWith(queryError(denied)).admin)).toBe(
      false,
    );
    const body = { data: null, errors: [denied] };
    expect(await canReadProducts(adminWith(body).admin)).toBe(false);
    const forbidden = new Response(null, { status: 403 });
    expect(await canReadProducts(adminWith(forbidden).admin)).toBe(false);
  });

  it("throws an AdminApiError when the check itself fails, and passes re-auth on", async () => {
    const other = { message: "Internal", extensions: { code: "INTERNAL" } };
    for (const step of [
      new Error("socket hang up"),
      new Response("Service Unavailable", { status: 503 }),
      queryError(other),
      queryError(null),
      { errors: [other] },
      { errors: "Not Found" },
      { data: { products: null } },
      {},
    ]) {
      const err = await canReadProducts(adminWith(step).admin).catch((e) => e);
      expect(err).toBeInstanceOf(AdminApiError);
      // Logged by the route, never shown (§15).
      expect(err.detail).toEqual(expect.any(String));
    }
    const reauth = new Response(null, { status: 401 });
    await expect(canReadProducts(adminWith(reauth).admin)).rejects.toBe(reauth);
  });
});

describe("streamed", () => {
  // What the library throws once Shopify refuses a revoked token: its bounce
  // page for a document request, else a 401 the browser retries.
  const revoked = () =>
    new Response(null, {
      status: 302,
      headers: { Location: "/auth/session-token" },
    });
  const first = { graphql: vi.fn() } as unknown as Admin;
  const fresh = { graphql: vi.fn() } as unknown as Admin;

  it("signs in again and loads once more when the staff member's token was revoked (§3)", async () => {
    const signIn = vi.fn(async () => ({ admin: fresh }));
    const load = vi.fn(async (admin: Admin) => {
      if (admin === first) throw revoked();
      return "loaded";
    });
    await expect(streamed(first, signIn, load)).resolves.toBe("loaded");
    expect(load.mock.calls.map(([a]) => a)).toEqual([first, fresh]);
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("signs in again only for a revoked token, and tries only once more", async () => {
    const signIn = vi.fn(async () => ({ admin: fresh }));
    const failed = new AdminApiError("Shopify request failed", "HTTP 503");
    await expect(
      streamed(first, signIn, async () => {
        throw failed;
      }),
    ).rejects.toBe(failed);
    expect(signIn).not.toHaveBeenCalled();

    const again = revoked();
    const load = vi.fn(async () => {
      throw again;
    });
    await expect(streamed(first, signIn, load)).rejects.toBe(again);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("leaves no unhandled rejection when the page was left and nothing reads the load", async () => {
    vi.useRealTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    void streamed(first, vi.fn(), async () => {
      throw new Error("unexpected");
    });
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("pricingPlansUrl", () => {
  it("links to Shopify's plan page for this store and the app's own handle", async () => {
    const { admin } = adminWith({
      data: { currentAppInstallation: { app: { handle: "fitted-2" } } },
    });
    await expect(
      pricingPlansUrl(admin, "fitted-test.myshopify.com"),
    ).resolves.toBe(
      "https://admin.shopify.com/store/fitted-test/charges/fitted-2/pricing_plans",
    );
  });
});
