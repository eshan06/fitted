// The chart editor's reads and saves (ARCHITECTURE §5, §8, §15): load a chart
// or mint a new chart's handle, then create, update, publish or unpublish it.
import { randomInt } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { authenticate } from "../shopify.server";
import { AdminApiError, canReadProducts } from "../models/admin.server";
import {
  ChartConflictError,
  ChartNotFoundError,
  ChartValidationError,
  countActiveCharts,
  createChart,
  getChart,
  publishChart,
  unpublishChart,
  updateChart,
  validateChart,
} from "../models/chart.server";
import { canPublishChart, getPlan } from "../models/billing.server";
import { startResolve } from "../models/rules.server";

const ROUTE = "app.charts.$id";
// Thrown as a Response (§15); the app's error boundary prints its text.
const notFound = () =>
  new Response("This chart doesn't exist. It may have been deleted.", {
    status: 404,
  });
const gid = (id: string | undefined) => {
  if (!id || !/^\d{1,20}$/.test(id)) throw notFound();
  return `gid://shopify/Metaobject/${id}`;
};
const logShopifyError = (shop: string, err: AdminApiError) =>
  console.log(
    JSON.stringify({
      level: "error",
      msg: err.message,
      shop,
      route: ROUTE,
      detail: err.detail,
    }),
  );

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (params.id === "new") {
    // Minted once per visit and resent on every retry, so a retried create lands on one chart (§5).
    const a = "abcdefghijklmnopqrstuvwxyz0123456789";
    const handle = `c-${Array.from({ length: 10 }, () => a[randomInt(36)]).join("")}`;
    return { mode: "new" as const, handle };
  }
  const id = gid(params.id);
  try {
    return { mode: "edit" as const, stored: await getChart(admin, id) };
  } catch (err) {
    if (err instanceof ChartNotFoundError) throw notFound();
    if (!(err instanceof AdminApiError)) throw err;
    logShopifyError(session.shop, err);
    return data(
      {
        mode: "error" as const,
        error: {
          code: "shopify",
          message:
            "Fitted couldn't reach your store just now. Nothing about the chart has changed, and shoppers still see it as before.",
        },
      },
      { status: 502 },
    );
  }
};

const fail = (status: number, code: string, message: string) =>
  data({ error: { code, message } }, { status });

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const isNew = params.id === "new";
  const id = isNew ? "" : gid(params.id);
  const body = await request.json().catch(() => null);
  try {
    if (typeof body !== "object" || body === null)
      throw new ChartValidationError({ "": "Must be a chart" });
    validateChart(body.chart);
    if (isNew) {
      const created = await createChart(admin, body.handle, body.chart);
      return redirect(`/app/charts/${created.id.split("/").pop()}`);
    }
    const { status } = body;
    if (status !== "ACTIVE" && status !== "DRAFT")
      throw new ChartValidationError({ status: "Pick Published or Draft" });
    // Free's limit is checked before anything is written (§8).
    // ponytail: two publishes at once can both pass; a per-shop lock if that ever matters.
    if (
      status === "ACTIVE" &&
      (await getChart(admin, id)).status !== "ACTIVE"
    ) {
      const { plan, checkFailed } = await getPlan(session.shop);
      if (!canPublishChart(plan, await countActiveCharts(admin)))
        return fail(
          403,
          "plan_limit",
          `${checkFailed ? "Fitted couldn't check your plan just now, so it counts as Free. " : ""}Free includes 3 published charts. Nothing was saved: set this chart to Draft to save your changes, or upgrade to Standard to publish more.`,
        );
    }
    const saved = await updateChart(admin, id, body.chart, body.updatedAt);
    if (saved.status === status) return { ok: true as const };
    // A failed action doesn't reload the chart, so the next save needs the new updatedAt.
    const still = (http: number, code: string, then: string) =>
      data(
        {
          error: {
            code,
            message: `Your edits were saved, but the chart is still ${saved.status === "ACTIVE" ? "Published" : "a Draft"}. ${then}`,
          },
          updatedAt: saved.updatedAt,
        },
        { status: http },
      );
    try {
      // The status moves products onto or off the chart, which the resolve job does with the offline token (§13).
      if (!(await canReadProducts(admin)))
        return still(
          403,
          "product_access",
          "Publishing or unpublishing it changes which products show it, which needs access to products. Ask the store owner for it.",
        );
      await (status === "ACTIVE" ? publishChart : unpublishChart)(admin, id);
    } catch (err) {
      if (!(err instanceof AdminApiError)) throw err;
      logShopifyError(session.shop, err);
      return still(502, "status", "Change its status and save again.");
    }
    // Every product follows, `auto: false` charts included (§6).
    void startResolve(session.shop, true);
    return { ok: true as const };
  } catch (err) {
    if (err instanceof ChartValidationError)
      return data({ fieldErrors: err.fieldErrors }, { status: 422 });
    if (err instanceof ChartConflictError)
      return fail(409, "conflict", err.message);
    if (err instanceof ChartNotFoundError) throw notFound();
    if (!(err instanceof AdminApiError)) throw err;
    logShopifyError(session.shop, err);
    return fail(
      502,
      "shopify",
      "Fitted couldn't save to Shopify just now, so the chart on your store hasn't changed. Your edits are still here.",
    );
  }
};

// Placeholder until the editor screen step builds the Editor board on this
// loader and action.
export default function ChartEditor() {
  return <s-page heading="Chart editor"></s-page>;
}
