// The size charts list (ARCHITECTURE §2, §5, §6, §8, §13): status, product counts, search, Free's limit, delete, CSV export.
import { Suspense, useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Await,
  data,
  useFetcher,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import {
  type Admin,
  AccessDeniedError,
  AdminApiError,
  canReadProducts,
  pricingPlansUrl,
} from "../models/admin.server";
import { NO_ACCESS, NoAccess } from "../components/no-access";
import {
  ChartNotFoundError,
  chartPages,
  countChartProducts,
  deleteChart,
  type ChartStatus,
  type StoredChart,
  type Template,
} from "../models/chart.server";
import {
  FREE_ACTIVE_CHARTS,
  lastConfirmedPlan,
  type Plan,
} from "../models/billing.server";
import { startResolve } from "../models/rules.server";
import { templateCard } from "../data/templates";

const ROUTE = "app.charts._index";
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

export type Row = {
  id: string;
  name: string;
  template: Template | null; // null: the stored chart fails validation (§5)
  status: ChartStatus;
  products: { count: number; atLeast: boolean };
  updatedAt: string;
};
export type ChartList =
  | { rows: Row[]; limit: { active: number; plansUrl: string } | null }
  | { error: { code: string; message: string } };

// ponytail: reads every chart and its count on each load; page the list if stores keep hundreds.
async function loadList(
  admin: Admin,
  shop: string,
  plan: Plan,
): Promise<ChartList> {
  try {
    const charts: StoredChart[] = [];
    for await (const page of chartPages(admin)) charts.push(...page);
    const counts = await countChartProducts(
      admin,
      charts.map((c) => c.id),
    );
    const active = charts.filter((c) => c.status === "ACTIVE").length;
    const rows = charts
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({
        id: c.id,
        name: c.name || "Untitled chart",
        template: c.chart?.template ?? null,
        status: c.status,
        products: counts[c.id],
        updatedAt: c.updatedAt,
      }));
    const limit =
      plan === "free" && active >= FREE_ACTIVE_CHARTS
        ? { active, plansUrl: await pricingPlansUrl(admin, shop) }
        : null;
    return { rows, limit };
  } catch (err) {
    if (!(err instanceof AdminApiError)) throw err;
    logShopifyError(shop, err);
    if (err instanceof AccessDeniedError) return { error: NO_ACCESS };
    const message = "Fitted didn't get an answer from your store.";
    return { error: { code: "shopify", message } };
  }
}

// Streamed, so the list shows its loading state while Shopify answers. On the
// last confirmed plan, so a slow plan check never holds the stream; the shell
// reloads the list if the check settles on another (app.tsx).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const planAtLoad = await lastConfirmedPlan(session.shop);
  return {
    planAtLoad,
    list: loadList(admin, session.shop, planAtLoad.plan),
  };
};

const fail = (status: number, code: string, message: string) =>
  data({ error: { code, message } }, { status });

// Deletes one chart, then moves its products to the next matching chart (§6).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const id = (await request.formData().catch(() => null))?.get("id");
  if (typeof id !== "string" || !/^gid:\/\/shopify\/Metaobject\/\d+$/.test(id))
    return data(
      {
        fieldErrors: {
          id: "Fitted couldn't tell which chart to delete, so nothing was deleted. Reload the page and try again.",
        },
      },
      { status: 422 },
    );
  // Every product leaves the deleted chart, `auto: false` charts included (§6).
  const resolve = () => void startResolve(session.shop, true);
  let deleting = false;
  try {
    // The resolve job that moves its products runs with the offline token (§13).
    if (!(await canReadProducts(admin)))
      return fail(
        403,
        "product_access",
        "Deleting a chart changes which products show a size guide, which needs the Products permission on your staff account. Nothing was deleted. Ask the store owner to give you Products access in Settings › Users, then try again.",
      );
    deleting = true;
    await deleteChart(admin, id);
  } catch (err) {
    // Already gone (a repeated delete, or someone else's): the delete is done.
    if (!(err instanceof ChartNotFoundError)) {
      if (!(err instanceof AdminApiError)) throw err;
      logShopifyError(session.shop, err);
      // The delete may have landed with its answer lost: resolving is harmless either way.
      if (deleting) resolve();
      return fail(
        502,
        "shopify",
        "Fitted didn't get an answer from your store, so the chart may not be deleted. If it's still in your list, products still show it.",
      );
    }
  }
  resolve();
  return { ok: true as const };
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const products = ({ count, atLeast }: Row["products"]) =>
  `${count.toLocaleString("en-US")}${atLeast ? "+" : ""}`;
// "Nov 14, 2026". ponytail: UTC, not the shop's time zone; read shop.ianaTimezone if a day off ever matters.
const DAY = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const STATUSES = { all: "All", ACTIVE: "Active", DRAFT: "Draft" };
export const filterRows = (rows: Row[], q: string, status: string) =>
  rows.filter(
    (r) =>
      (status === "all" || r.status === status) &&
      r.name.toLowerCase().includes(q.trim().toLowerCase()),
  );

type Export =
  | { state: "idle" | "busy" | "failed"; count: number }
  | { state: "done"; count: number; file: string };

// Fetched rather than linked, so App Bridge adds the session token and the
// app's frame never navigates; read as bytes to keep the BOM (#33).
async function downloadExport(): Promise<string | null> {
  try {
    const res = await fetch("/app/export");
    // Anything but the CSV (a 502, a sign-in page) is a failure, never a file.
    if (!res.ok || !res.headers.get("Content-Type")?.startsWith("text/csv"))
      return null;
    const blob = await res.blob();
    const file =
      /filename="([^"]+)"/.exec(
        res.headers.get("Content-Disposition") ?? "",
      )?.[1] ?? "fitted-charts.csv";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return file;
  } catch {
    return null;
  }
}

const SR_ONLY = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
} as const;

export default function SizeCharts() {
  const { list } = useLoaderData<typeof loader>();
  const [exp, setExp] = useState<Export>({ state: "idle", count: 0 });
  const busy = exp.state === "busy";
  // A ref, so two clicks before the next render still start one export.
  const running = useRef(false);
  const run = async (count: number) => {
    if (running.current) return;
    running.current = true;
    setExp({ state: "busy", count });
    const file = await downloadExport();
    running.current = false;
    setExp(file ? { state: "done", count, file } : { state: "failed", count });
  };
  return (
    <s-page heading="Size charts">
      <s-button slot="primary-action" variant="primary" href="/app/charts/new">
        New chart
      </s-button>
      {/* Only over a list of charts, as drawn: not while loading, empty or failed. */}
      <Suspense fallback={null}>
        <Await resolve={list} errorElement={<></>}>
          {(l) =>
            "rows" in l &&
            l.rows.length > 0 && (
              <s-button
                slot="secondary-actions"
                {...(busy && { loading: true })}
                onClick={() => run(l.rows.length)}
              >
                {busy ? "Exporting" : "Export CSV"}
              </s-button>
            )
          }
        </Await>
      </Suspense>
      <s-button slot="secondary-actions" href="/app/import">
        Import from Kiwi
      </s-button>
      <s-stack gap="base">
        <s-paragraph color="subdued">
          Saved in your store. Shoppers see the Active ones.
        </s-paragraph>
        {/* Always mounted, so screen readers announce the text when it arrives. */}
        <span role="status" style={SR_ONLY}>
          {busy && `Exporting ${plural(exp.count, "chart")} to CSV`}
        </span>
        {exp.state === "done" && (
          <s-banner
            tone="info"
            heading={`Exported ${plural(exp.count, "chart")} to ${exp.file}`}
          >
            <s-paragraph>
              {
                "It's in your downloads. If you save it from Excel or Google Sheets, check your sizes before importing it again, since they can turn 10-12 into a date or 00 into 0."
              }
            </s-paragraph>
          </s-banner>
        )}
        {exp.state === "failed" && (
          <s-banner tone="critical" heading="Charts didn't export">
            <s-paragraph>
              {
                "Shopify didn't respond, so no file was downloaded. Your charts haven't changed."
              }
            </s-paragraph>
            <s-button slot="secondary-actions" onClick={() => run(exp.count)}>
              Try again
            </s-button>
          </s-banner>
        )}
        <Suspense fallback={<Loading />}>
          <Await resolve={list} errorElement={<LoadError />}>
            {(l) =>
              !("error" in l) ? (
                <Charts {...l} />
              ) : l.error.code === "access" ? (
                <NoAccess />
              ) : (
                <LoadError />
              )
            }
          </Await>
        </Suspense>
      </s-stack>
    </s-page>
  );
}

const HEADERS = (
  <s-table-header-row>
    <s-table-header listSlot="primary">Chart</s-table-header>
    <s-table-header listSlot="inline">Status</s-table-header>
    <s-table-header listSlot="labeled" format="numeric">
      Products
    </s-table-header>
    <s-table-header listSlot="labeled">Last edited</s-table-header>
    <s-table-header listSlot="secondary">
      <s-text accessibilityVisibility="exclusive">Actions</s-text>
    </s-table-header>
  </s-table-header-row>
);

function Loading() {
  return (
    <s-section padding="none" accessibilityLabel="Loading your size charts">
      <s-table loading>
        {HEADERS}
        <s-table-body></s-table-body>
      </s-table>
    </s-section>
  );
}

function LoadError() {
  const { revalidate, state } = useRevalidator();
  return (
    <s-banner tone="critical" heading="We couldn't load your size charts">
      <s-paragraph>
        {
          "Fitted didn't get an answer from your store this time. Nothing was changed: your charts are still saved in your store, and shoppers still see them."
        }
      </s-paragraph>
      <s-paragraph>
        {
          "Still not loading after a minute? Email us at [SUPPORT EMAIL] and we'll look into it."
        }
      </s-paragraph>
      <s-button
        slot="secondary-actions"
        // React 18 writes `false` as the string "false", which still counts as set.
        {...(state === "loading" && { loading: true })}
        onClick={() => revalidate()}
      >
        Try again
      </s-button>
    </s-banner>
  );
}

// The canvas's status mark (solid Active, dashed Draft) and empty-state logo.
const Status = ({ status }: { status: ChartStatus }) => {
  const on = status === "ACTIVE";
  const color = on ? "#2448A8" : "#3D4043";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <svg width="16" height="2" aria-hidden="true">
        <path
          d="M0 1h16"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={on ? "" : "4 3"}
        />
      </svg>
      <span style={{ color, fontWeight: 600 }}>{on ? "Active" : "Draft"}</span>
    </span>
  );
};

const LOGO = [
  ["M10 40V10h30", "#161616", "1.2", "3 2"],
  ["M17 40V17h23", "#2448A8", "2.6", ""],
  ["M24 40V24h16", "#161616", "1.2", ""],
  ["M31 40V31h9", "#161616", "1.2", "1 2"],
];
// React 18 never hears Polaris fields' non-bubbling `input`; `oninput` replaces the last render's.
const listen = (set: (v: string) => void) => (el: HTMLElement | null) => {
  if (el) el.oninput = () => set((el as HTMLInputElement).value ?? "");
};

type Deleted =
  | { ok: true }
  | { error: { code: string; message: string } }
  | { fieldErrors: { id: string } };

// The "Delete chart" confirmation; Delete becomes Try again after a failure (§15).
function DeleteChart({
  target,
  opened,
}: {
  target: Row | null;
  opened: number;
}) {
  // A fresh fetcher each time the confirmation opens, so no earlier failure shows.
  const fetcher = useFetcher<Deleted>({ key: `delete-chart-${opened}` });
  const modal = useRef<HTMLElementTagNameMap["s-modal"]>(null);
  const busy = fetcher.state !== "idle";
  const answer = busy ? undefined : fetcher.data;
  useEffect(() => {
    if (answer && "ok" in answer) modal.current?.hideOverlay?.();
  }, [answer]);
  const failed =
    answer && "error" in answer
      ? answer.error.message
      : answer && "fieldErrors" in answer
        ? answer.fieldErrors.id
        : null;
  const n = target?.products;
  return (
    <s-modal
      ref={modal}
      id="delete-chart"
      heading={target ? `Delete ${target.name}?` : "Delete chart"}
    >
      <s-stack gap="base">
        {failed && (
          <s-banner tone="critical" heading="We couldn't delete this chart">
            <s-paragraph>{failed}</s-paragraph>
          </s-banner>
        )}
        <s-paragraph>
          {!n || n.count === 0
            ? "No products show it."
            : `It shows on ${products(n)} ${n.count === 1 && !n.atLeast ? "product" : "products"}. They'll show the next chart that matches them, or no size guide.`}
        </s-paragraph>
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        {...(busy && { loading: true })}
        onClick={() =>
          target && fetcher.submit({ id: target.id }, { method: "post" })
        }
      >
        {fetcher.data && !("ok" in fetcher.data) ? "Try again" : "Delete"}
      </s-button>
      <s-button
        slot="secondary-actions"
        {...(busy && { disabled: true })}
        commandFor="delete-chart"
        command="--hide"
      >
        Cancel
      </s-button>
    </s-modal>
  );
}

export function Charts({ rows, limit }: Extract<ChartList, { rows: unknown }>) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [target, setTarget] = useState<Row | null>(null);
  const [opened, setOpened] = useState(0);
  if (!rows.length)
    return (
      <s-section accessibilityLabel="No size charts yet">
        <s-stack gap="base" alignItems="center" padding="large">
          <svg width="112" height="112" viewBox="0 0 48 48" aria-hidden="true">
            {LOGO.map(([d, color, width, dash]) => (
              <path
                key={d}
                {...{ d, stroke: color, strokeWidth: width }}
                strokeDasharray={dash}
                fill="none"
                strokeLinecap="square"
              />
            ))}
          </svg>
          <s-heading>No size charts yet</s-heading>
          <s-paragraph>
            Moving from Kiwi? Import brings over the charts your store shows
            today, free on every plan. Starting fresh? Pick a template and fill
            in your numbers.
          </s-paragraph>
          <s-stack direction="inline" gap="small" justifyContent="center">
            <s-button variant="primary" href="/app/import">
              Import from Kiwi
            </s-button>
            <s-button href="/app/charts/new">New chart</s-button>
          </s-stack>
          <s-paragraph color="subdued">
            <em>Measure twice, publish once.</em>
          </s-paragraph>
        </s-stack>
      </s-section>
    );

  const shown = filterRows(rows, q, status);
  return (
    <>
      {limit && (
        <s-banner
          tone="info"
          heading={`Free plan: ${limit.active} of 3 Active charts`}
        >
          <s-stack gap="small-200">
            <s-paragraph>
              {
                "Drafts don't count. To make a 4th Active, set one to Draft or move to Standard, $9 a month."
              }
            </s-paragraph>
            <s-link href={limit.plansUrl} target="_top">
              Change plan
            </s-link>
          </s-stack>
        </s-banner>
      )}
      <s-section padding="none" accessibilityLabel="Your size charts">
        <s-box padding="small base">
          <s-grid
            gridTemplateColumns="1fr auto"
            gap="small"
            alignItems="center"
          >
            <s-search-field
              ref={listen((v) => setQ(v))}
              label="Search charts"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search charts by name"
              value={q}
            />
            <s-select
              ref={listen((v) => setStatus(v))}
              label="Status"
              value={status}
            >
              {Object.entries(STATUSES).map(([value, label]) => (
                <s-option key={value} value={value}>
                  {label}
                </s-option>
              ))}
            </s-select>
          </s-grid>
        </s-box>
        {shown.length ? (
          <>
            <s-table variant="auto">
              {HEADERS}
              <s-table-body>
                {shown.map((r) => (
                  <s-table-row key={r.id}>
                    <s-table-cell>
                      <s-stack gap="small-500">
                        <s-link href={`/app/charts/${r.id.split("/").pop()}`}>
                          {r.name}
                        </s-link>
                        <s-text color="subdued">
                          {r.template
                            ? templateCard(r.template).name
                            : "This chart has errors. Open it to fix them."}
                        </s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <Status status={r.status} />
                    </s-table-cell>
                    <s-table-cell>{products(r.products)}</s-table-cell>
                    <s-table-cell>
                      {DAY.format(new Date(r.updatedAt))}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        icon="menu-horizontal"
                        variant="tertiary"
                        accessibilityLabel={`Actions for ${r.name}`}
                        commandFor={`actions-${r.id.split("/").pop()}`}
                      />
                      <s-menu
                        id={`actions-${r.id.split("/").pop()}`}
                        accessibilityLabel={`Actions for ${r.name}`}
                      >
                        <s-button
                          tone="critical"
                          commandFor="delete-chart"
                          command="--show"
                          onClick={() => {
                            setTarget(r);
                            setOpened(opened + 1);
                          }}
                        >
                          Delete
                        </s-button>
                      </s-menu>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            <s-box padding="small base">
              <s-text color="subdued">
                {shown.length === rows.length
                  ? plural(rows.length, "chart")
                  : `${shown.length} of ${plural(rows.length, "chart")}`}
              </s-text>
            </s-box>
          </>
        ) : (
          <s-stack gap="small" alignItems="center" padding="large">
            <s-heading>
              No charts match “{q.trim() || STATUSES[status as "all"]}”
            </s-heading>
            <s-paragraph color="subdued">
              Try another word from the chart name, or clear the search to see
              all charts.
            </s-paragraph>
            <s-button
              onClick={() => {
                setQ("");
                setStatus("all");
              }}
            >
              Clear search
            </s-button>
          </s-stack>
        )}
      </s-section>
      <DeleteChart target={target} opened={opened} />
    </>
  );
}
