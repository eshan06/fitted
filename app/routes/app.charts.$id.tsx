// The chart editor's reads and saves (ARCHITECTURE §5, §8, §15): load a chart
// or mint a new chart's handle, then create, update, publish or unpublish it.
import { randomInt } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, data, useLoaderData, useRevalidator } from "react-router";
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
import {
  FREE_ACTIVE_CHARTS,
  canPublishChart,
  getPlan,
  plansUrl,
} from "../models/billing.server";
import { startResolve } from "../models/rules.server";
import { Editor } from "../components/chart-table/Editor";
import {
  blankDraft,
  storedDraft,
  toDraft,
} from "../components/chart-table/model";

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
      const published = await countActiveCharts(admin);
      if (!canPublishChart(plan, published))
        return data(
          {
            error: {
              code: "plan_limit",
              message: `${checkFailed ? "Fitted couldn't check your plan just now, so it counts as Free. " : ""}Free includes ${FREE_ACTIVE_CHARTS} published charts. Nothing was saved: set this chart to Draft to save your changes, or upgrade to Standard to publish more.`,
              // The banner's numbers and its See plans link.
              limit: FREE_ACTIVE_CHARTS,
              published,
              checkFailed,
              plansUrl: plansUrl(session.shop),
            },
          },
          { status: 403 },
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
          "Publishing or unpublishing a chart changes which products show it, which needs the Products permission on your staff account. Ask the store owner to give you Products access in Settings › Users, then save again.",
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

// The Editor board's states: the editor itself, loading, couldn't load, and a
// stored chart that fails the checks (opened with its values marked when the
// table can be drawn, else its banner alone).
export default function ChartEditor() {
  const loaded = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  if (loaded.mode === "new")
    return <Editor key="new" initial={blankDraft()} handle={loaded.handle} />;
  const s = loaded.mode === "edit" ? loaded.stored : undefined;
  const initial = s?.chart
    ? toDraft(s.chart, s.status)
    : s && storedDraft(s.raw, s.status);
  if (s && initial)
    return (
      <Editor
        key={`${s.updatedAt}|${s.status}`}
        initial={initial}
        updatedAt={s.updatedAt}
        invalid={s.fieldErrors}
      />
    );
  const invalid = loaded.mode === "edit" ? loaded.stored.fieldErrors : null;
  const count = Object.keys(invalid ?? {}).length;
  return (
    <s-page>
      <div className="editor">
        <Link to="/app/charts">Size charts</Link>
        {revalidator.state === "loading" ? (
          <div role="status" className="card">
            <span className="visually-hidden">Loading chart</span>
            <span className="sk" />
            <span className="sk short" />
          </div>
        ) : invalid ? (
          // Too broken to draw as a table: Fitted never wrote it.
          <s-banner
            tone="critical"
            heading={`Fix ${count} ${count === 1 ? "value" : "values"} to save this chart`}
          >
            They were changed outside Fitted. Nothing on your store has changed.
          </s-banner>
        ) : (
          <>
            <s-banner tone="critical" heading="This chart didn't load">
              Fitted couldn&apos;t reach your store just now. Nothing about the
              chart has changed, and shoppers still see it as before.
              <s-button
                slot="secondary-actions"
                onClick={() => revalidator.revalidate()}
              >
                Try again
              </s-button>
            </s-banner>
            <p className="help">
              Still not working? Email [SUPPORT EMAIL] and we&apos;ll look into
              it.
            </p>
          </>
        )}
      </div>
    </s-page>
  );
}
