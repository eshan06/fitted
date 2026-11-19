// The size charts list (ARCHITECTURE §2, §5, §8): every chart with its status
// and product count, search, and Free's limit.
import { Suspense, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Await, useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import {
  type Admin,
  AdminApiError,
  pricingPlansUrl,
} from "../models/admin.server";
import {
  chartPages,
  countChartProducts,
  type ChartStatus,
  type StoredChart,
  type Template,
} from "../models/chart.server";
import { FREE_ACTIVE_CHARTS, getPlan } from "../models/billing.server";

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
async function loadList(admin: Admin, shop: string): Promise<ChartList> {
  try {
    const charts: StoredChart[] = [];
    for await (const page of chartPages(admin)) charts.push(...page);
    const [counts, { plan }] = await Promise.all([
      countChartProducts(
        admin,
        charts.map((c) => c.id),
      ),
      getPlan(shop),
    ]);
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
    console.log(
      JSON.stringify({
        level: "error",
        msg: err.message,
        shop,
        route: "app.charts._index",
        detail: err.detail,
      }),
    );
    const message = "Fitted didn't get an answer from your store.";
    return { error: { code: "shopify", message } };
  }
}

// Streamed, so the list shows its loading state while Shopify answers.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  return { list: loadList(admin, session.shop) };
};

const TEMPLATES: Record<Template, string> = {
  blank: "Blank chart",
  tops: "Tops",
  bottoms: "Bottoms",
  dresses: "Dresses",
  bras_swimwear: "Bras and swimwear",
  shoes: "Shoes",
  kids: "Kids",
  headwear: "Headwear",
  rings: "Rings",
  bracelets: "Bracelets",
  necklaces: "Necklaces",
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

export default function SizeCharts() {
  const { list } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Size charts">
      <s-button slot="primary-action" variant="primary" href="/app/charts/new">
        New chart
      </s-button>
      <s-button slot="secondary-actions" href="/app/import">
        Import from Kiwi
      </s-button>
      <s-stack gap="base">
        <s-paragraph color="subdued">
          Saved in your store. Shoppers see the Active ones.
        </s-paragraph>
        <Suspense fallback={<Loading />}>
          <Await resolve={list} errorElement={<LoadError />}>
            {(l) => ("error" in l ? <LoadError /> : <Charts {...l} />)}
          </Await>
        </Suspense>
      </s-stack>
    </s-page>
  );
}

function Loading() {
  return (
    <s-section padding="none" accessibilityLabel="Loading your size charts">
      <s-table loading>
        <s-table-header-row>
          <s-table-header listSlot="primary">Chart</s-table-header>
          <s-table-header listSlot="inline">Status</s-table-header>
          <s-table-header listSlot="labeled">Products</s-table-header>
          <s-table-header listSlot="labeled">Last edited</s-table-header>
        </s-table-header-row>
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

// The canvas's status mark: a solid line for Active, dashed for Draft.
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

// The canvas's empty-state mark: [path, color, width, dashes].
const LOGO = [
  ["M10 40V10h30", "#161616", "1.2", "3 2"],
  ["M17 40V17h23", "#2448A8", "2.6", ""],
  ["M24 40V24h16", "#161616", "1.2", ""],
  ["M31 40V31h9", "#161616", "1.2", "1 2"],
];
// React 18 never hears a Polaris field's `input` (it doesn't bubble), so
// listen on the element itself; assigning `oninput` replaces the last render's.
const listen = (set: (v: string) => void) => (el: HTMLElement | null) => {
  if (el) el.oninput = () => set((el as HTMLInputElement).value ?? "");
};

export function Charts({ rows, limit }: Extract<ChartList, { rows: unknown }>) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
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
              <s-table-header-row>
                <s-table-header listSlot="primary">Chart</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">
                  Products
                </s-table-header>
                <s-table-header listSlot="labeled">Last edited</s-table-header>
              </s-table-header-row>
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
                            ? TEMPLATES[r.template]
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
    </>
  );
}
