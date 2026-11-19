import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Admin, AdminApiError, adminGraphql } from "./admin.server";

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
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("adminGraphql", () => {
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
    const reauth = new Response(null, { status: 401 });
    const { admin, graphql } = adminWith(reauth, { data: {} });
    const r = await run(adminGraphql(admin, "q", {}, { retry: true }));
    expect(r.error).toBe(reauth);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("never puts Shopify's raw text in its message", async () => {
    const { admin } = adminWith(new Error("secret internal detail"));
    const r = await run(adminGraphql(admin, "q"));
    expect((r.error as Error).message).not.toContain("secret");
  });
});
