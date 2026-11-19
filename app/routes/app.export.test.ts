import type { LoaderFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importCsv } from "../models/csv-import.server";
import { loader } from "./app.export";

const { admin } = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("../shopify.server", () => ({ authenticate: { admin } }));

const shop = "fitted-test.myshopify.com";
const content = (size: string) => ({
  v: 1,
  unit: "in",
  roundTo: 0.5,
  tables: [
    {
      id: "t1",
      columns: [
        { id: "size", kind: "size" },
        { id: "chest", kind: "measure", convert: true },
      ],
      rows: [{ id: "s", cells: { chest: [34, 35.5] } }],
    },
  ],
  measure: { steps: [] },
  words: { "t1.size": "Size", "t1.s.size": size },
});
// A chart as the Admin API returns it (see chart.server's ChartFields).
const node = (n: number, name: string, json: unknown) => ({
  id: `gid://shopify/Metaobject/${n}`,
  handle: `c-000000000${n}`,
  type: "app--1--chart",
  updatedAt: "2026-11-18T00:00:00Z",
  capabilities: { publishable: { status: "ACTIVE" } },
  name: { value: name },
  template: { value: "tops" },
  content: { jsonValue: json },
  measureImage: { value: null },
  importNote: { value: null },
});
const pages: Record<string, unknown> = {
  first: {
    nodes: [node(1, "Women's tops", content("S"))],
    pageInfo: { hasNextPage: true, endCursor: "p2" },
  },
  p2: {
    nodes: [node(2, "Men's shirts", content("M")), node(3, "Broken", { v: 2 })],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};
const graphql =
  vi.fn<
    (q: string, o: { variables: { after: string | null } }) => Promise<Response>
  >();
const request = () => new Request("https://fitted.test/app/export");
const load = (req = request()) =>
  loader({ request: req } as LoaderFunctionArgs) as Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  graphql.mockImplementation(async (_query, { variables }) =>
    Response.json({ data: { metaobjects: pages[variables.after ?? "first"] } }),
  );
  admin.mockResolvedValue({ admin: { graphql }, session: { shop } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CSV export", () => {
  it("downloads every chart, across pages, as one CSV file", async () => {
    const req = request();
    const response = await load(req);

    expect(admin).toHaveBeenCalledExactlyOnceWith(req);
    expect(graphql.mock.calls.map(([, o]) => o.variables.after)).toEqual([
      null,
      "p2",
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="fitted-charts-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const charts = await importCsv(response.body);
    expect(charts.map((c) => [c.name, c.status])).toEqual([
      ["Women's tops", "ready"],
      ["Men's shirts", "ready"],
      // A chart that fails validation is named, never dropped (§5).
      ["Broken", "unreadable"],
    ]);
    expect(charts[1].status === "ready" && charts[1].content).toEqual(
      content("M"),
    );
  });

  it("passes the library's login redirect on without calling Shopify", async () => {
    const login = new Response(null, { status: 302 });
    admin.mockRejectedValue(login);

    await expect(load()).rejects.toBe(login);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("answers 502 when Shopify fails, logging the detail but never showing it", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    graphql.mockImplementation(async () =>
      Response.json({ errors: [{ message: "Internal secret detail" }] }),
    );

    const pending = load();
    await vi.runAllTimersAsync(); // the read's retries
    const response = await pending;

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "shopify",
        message: "Shopify didn't answer, so nothing was exported. Try again.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("secret");
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line).toMatchObject({
      level: "error",
      msg: "Chart export failed",
      shop,
      route: "app.export",
    });
    expect(line.detail).toContain("Internal secret detail");
  });

  it("passes a re-auth response from Shopify on, unanswered", async () => {
    const reauth = new Response(null, { status: 401 });
    graphql.mockRejectedValue(reauth);
    await expect(load()).rejects.toBe(reauth);
  });
});
