// Home (ARCHITECTURE §2, §6, §8): plan banner, setup guide, your charts and
// products without a chart. Opens stats come with #45.
import { Suspense, useEffect, useState, type ReactNode } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Await, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  type Admin,
  AdminApiError,
  pricingPlansUrl,
  themeEditorUrl,
} from "../models/admin.server";
import {
  chartPages,
  countChartProducts,
  productCoverage,
  type StoredChart,
} from "../models/chart.server";
import {
  canShowFitFinder,
  FREE_ACTIVE_CHARTS,
  getPlan,
  type Plan,
} from "../models/billing.server";
import { resolveIfStale } from "../models/rules.server";

const ROUTE = "app._index";
const SHOWN = 5; // charts in "Your charts"; Manage opens the full list

type N = { count: number; atLeast: boolean };
export type HomeRow = {
  id: string;
  name: string;
  status: StoredChart["status"];
  note: string | null; // an import's note ("Check units") until the editor saves
  products: N;
};
export type HomeData =
  | {
      plan: Plan;
      yearly: boolean | null; // billed yearly; null if no plan check has said
      plansUrl: string;
      themeUrl: string; // the theme editor, adding the size guide block
      charts: number;
      active: number;
      limit: number | null; // Free's limit of published charts, once reached
      imported: number;
      fitLive: boolean;
      rows: HomeRow[];
      products: { all: N; covered: N; missing: string[] };
    }
  | { error: { code: string; message: string } };

// ponytail: reads every chart and counts each one's products on every load; page it if stores keep hundreds.
async function loadHome(admin: Admin, shop: string): Promise<HomeData> {
  try {
    const charts: StoredChart[] = [];
    for await (const page of chartPages(admin)) charts.push(...page);
    const [counts, coverage, { plan, yearly }, plansUrl] = await Promise.all([
      countChartProducts(
        admin,
        charts.map((c) => c.id),
      ),
      productCoverage(admin),
      getPlan(shop),
      pricingPlansUrl(admin, shop),
    ]);
    const live = charts.filter((c) => c.status === "ACTIVE");
    const active = live.length;
    return {
      plan,
      yearly,
      plansUrl,
      themeUrl: themeEditorUrl(shop),
      charts: charts.length,
      active,
      limit:
        plan === "free" && active >= FREE_ACTIVE_CHARTS
          ? FREE_ACTIVE_CHARTS
          : null,
      // Imports mint `i-` handles (§5). ponytail: every import source will, so
      // #34 tells Kiwi's apart before CSV import ships.
      imported: charts.filter((c) => c.handle.startsWith("i-")).length,
      fitLive: canShowFitFinder(plan) && live.some((c) => c.chart?.content.fit),
      rows: charts
        .map((c) => ({
          id: c.id,
          name: c.name || "Untitled chart",
          status: c.status,
          note: String(c.chart?.importNote ?? c.raw?.importNote ?? "") || null,
          products: counts[c.id],
        }))
        .sort((a, b) => b.products.count - a.products.count)
        .slice(0, SHOWN),
      products: {
        all: coverage.all,
        covered: coverage.covered,
        missing: coverage.missing.map((p) => p.title),
      },
    };
  } catch (err) {
    if (!(err instanceof AdminApiError)) throw err;
    console.log(
      JSON.stringify({
        level: "error",
        msg: err.message,
        shop,
        route: ROUTE,
        detail: err.detail,
      }),
    );
    const message = "Fitted didn't get an answer from your store.";
    return { error: { code: "shopify", message } };
  }
}

// Streamed, so Home shows its loading state while Shopify answers.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  void resolveIfStale(session.shop); // the daily reconcile (§6); never rejects
  return {
    storeUrl: `https://${session.shop}`,
    home: loadHome(admin, session.shop),
  };
};

const num = ({ count, atLeast }: N) =>
  `${count.toLocaleString("en-US")}${atLeast ? "+" : ""}`;

export default function Home() {
  const { home, storeUrl } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Home">
      <s-button slot="primary-action" variant="primary" href="/app/charts/new">
        Create chart
      </s-button>
      <s-button slot="secondary-actions" href={storeUrl} target="_blank">
        View on store
      </s-button>
      <s-stack gap="base">
        <s-paragraph color="subdued">Your size guides at a glance</s-paragraph>
        <Suspense fallback={<Loading />}>
          <Await resolve={home} errorElement={<LoadError />}>
            {(h) => ("error" in h ? <LoadError /> : <Dashboard {...h} />)}
          </Await>
        </Suspense>
      </s-stack>
    </s-page>
  );
}

const Bar = ({ w, h = 12 }: { w?: string; h?: number }) => (
  <div
    style={{ width: w, height: h, borderRadius: 6, background: "#E4E5E7" }}
  />
);
function Loading() {
  return (
    <s-stack gap="base" accessibilityLabel="Loading your size guides">
      <Bar h={48} />
      <s-section>
        <s-stack gap="base">
          <Bar w="140px" h={16} />
          <Bar h={6} />
          {["70%", "55%", "62%", "48%"].map((w) => (
            <Bar key={w} w={w} />
          ))}
        </s-stack>
      </s-section>
      <s-section>
        <s-stack gap="base">
          <Bar w="120px" h={16} />
          {[1, 2, 3, 4].map((i) => (
            <Bar key={i} />
          ))}
        </s-stack>
      </s-section>
    </s-stack>
  );
}

function LoadError() {
  const { revalidate, state } = useRevalidator();
  return (
    <>
      <s-banner tone="critical" heading="Your charts and numbers didn't load">
        <s-paragraph>
          {
            "Fitted couldn't reach your store just now. Your size guides are still showing to shoppers; only this page is affected."
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
      <s-paragraph color="subdued">
        {"Still not working? Email [SUPPORT EMAIL] and we'll look into it."}
      </s-paragraph>
    </>
  );
}

// Whether a block of the size guide's theme app extension is on in the live
// theme. Until App Bridge answers, or if it can't, the step shows as not done
// with its link, which is honest: we don't know it's on.
function useThemeOn() {
  const shopify = useAppBridge();
  const [on, setOn] = useState(false);
  useEffect(() => {
    shopify.app
      .extensions()
      .then((all) =>
        setOn(
          all.some(
            (e) =>
              e.type === "theme_app_extension" &&
              e.activations.some((a) => "status" in a && a.status === "active"),
          ),
        ),
      )
      .catch(() => {});
  }, [shopify]);
  return on;
}

type Step = {
  title: string;
  help: string;
  done: boolean;
  action?: ReactNode;
  children?: ReactNode;
};
const Mark = ({ done }: { done: boolean }) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <circle
      cx="12"
      cy="12"
      r="9"
      stroke={done ? "#2448A8" : "#8C9196"}
      strokeWidth="2"
      strokeDasharray={done ? "" : "3 3"}
    />
    {done && (
      <path
        d="m8 12 3 3 5-6"
        stroke="#2448A8"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )}
  </svg>
);

function SetupGuide({ steps }: { steps: Step[] }) {
  const done = steps.filter((s) => s.done).length;
  return (
    // Headed inside the card, count beside it, as the canvas draws it.
    <s-section accessibilityLabel="Setup guide">
      <s-stack gap="base">
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <s-heading>Setup guide</s-heading>
          <s-text color="subdued">{`${done} of ${steps.length} done`}</s-text>
        </s-grid>
        <div
          aria-hidden="true" // the count above says it
          style={{ height: 6, borderRadius: 999, background: "#E4E5E7" }}
        >
          <div
            style={{
              width: `${(100 * done) / steps.length}%`,
              height: 6,
              borderRadius: 999,
              background: "#2448A8",
            }}
          />
        </div>
        {steps.map((s) => (
          <s-stack key={s.title} gap="small">
            <s-divider />
            <s-grid
              gridTemplateColumns="auto 1fr"
              gap="base"
              alignItems="start"
            >
              <Mark done={s.done} />
              <s-stack gap="small">
                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="base"
                  alignItems="center"
                >
                  <s-stack gap="small-500">
                    <s-text type="strong">{s.title}</s-text>
                    <s-text color="subdued">{s.help}</s-text>
                  </s-stack>
                  {!s.done && s.action}
                </s-grid>
                {!s.done && s.children}
              </s-stack>
            </s-grid>
          </s-stack>
        ))}
      </s-stack>
    </s-section>
  );
}

const FIRST_WAYS = [
  [
    "Import from Kiwi",
    "We read the charts your store shows today. Free on every plan.",
    "Import charts",
    "/app/import",
  ],
  [
    "Start from a template",
    "Tops, bottoms, dresses, shoes, kids and more.",
    "Choose a template",
    "/app/charts/new",
  ],
  [
    "Upload a CSV",
    "Use our template or any spreadsheet export.",
    "Upload CSV",
    "/app/import",
  ],
];
const FIT_HELP = "Help shoppers pick a size in three quick questions.";

function steps(h: Ok, themeOn: boolean): Step[] {
  const first = h.charts === 0;
  const { all, covered } = h.products;
  const theme: Step = {
    title: "Turn on Fitted in your theme",
    help: themeOn
      ? "The size guide app embed is on in your live theme."
      : "One switch in your theme editor. We'll take you there.",
    done: themeOn,
    action: (
      <s-button href={h.themeUrl} target="_top">
        Open theme editor
      </s-button>
    ),
  };
  const chart: Step =
    h.imported > 0
      ? {
          title: "Move your charts from Kiwi",
          help: `${h.imported} ${h.imported === 1 ? "chart" : "charts"} imported. You can uninstall Kiwi once you've checked them.`,
          done: true,
        }
      : {
          title: "Add your first chart",
          help: "Shoppers see a size guide on any product that has a chart.",
          done: !first,
          children: (
            <s-grid
              gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))"
              gap="small"
            >
              {FIRST_WAYS.map(([title, help, label, href], i) => (
                <s-box
                  key={title}
                  padding="base"
                  border="base"
                  borderRadius="large"
                >
                  <s-stack gap="small">
                    <s-text type="strong">{title}</s-text>
                    <s-text color="subdued">{help}</s-text>
                    <s-button variant={i ? "secondary" : "primary"} href={href}>
                      {label}
                    </s-button>
                  </s-stack>
                </s-box>
              ))}
            </s-grid>
          ),
        };
  const products: Step = {
    title: "Choose which products show each chart",
    help:
      covered.count > 0
        ? `${num(covered)} of ${num(all)} products have a size guide.`
        : "Match by collection, tag, product type or vendor.",
    done: covered.count > 0,
    // A first install adds a chart before a rule can point at one.
    action: !first && <s-button href="/app/rules">Add a display rule</s-button>,
  };
  const pro = h.plan === "pro";
  const fit: Step = {
    title: "Add a fit finder",
    help: pro ? FIT_HELP : `${FIT_HELP} Part of Pro, $15 a month.`,
    done: h.fitLive,
    action: !first && (
      <s-button href="/app/fit-finder">
        {pro ? "Set up fit finder" : "Upgrade to Pro"}
      </s-button>
    ),
  };
  return first ? [chart, theme, products, fit] : [theme, chart, products, fit];
}

type Ok = Extract<HomeData, { plan: unknown }>;
export function Dashboard(h: Ok) {
  const themeOn = useThemeOn();
  const [showSteps, setShowSteps] = useState(false);
  const first = h.charts === 0;
  const { all, covered, missing: titles } = h.products;
  // Over 10,000 products Shopify's counts are floors, so the titles decide.
  const missing = {
    count: Math.max(all.count - covered.count, titles.length),
    atLeast: all.atLeast,
  };
  const heading = !titles.length
    ? "Every product has a size guide"
    : `${num(missing)} ${missing.count === 1 && !missing.atLeast ? "product has" : "products have"} no size guide`;
  const list = steps(h, themeOn);
  // Folds only when "Every product has a size guide" is also true.
  const allDone = list.every((s) => s.done) && !titles.length;
  return (
    <>
      <PlanBanner {...h} />
      {allDone && !showSteps ? (
        <s-section accessibilityLabel="Setup guide: all done">
          <s-grid
            gridTemplateColumns="auto 1fr auto"
            gap="base"
            alignItems="center"
          >
            <Mark done />
            <s-stack gap="small-500">
              <s-heading>Setup guide: all done</s-heading>
              <s-text color="subdued">
                Every product has a size guide, and the fit finder is live.
              </s-text>
            </s-stack>
            <s-button onClick={() => setShowSteps(true)}>Show steps</s-button>
          </s-grid>
        </s-section>
      ) : (
        <SetupGuide steps={list} />
      )}
      {!first && (
        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))"
          gap="base"
          alignItems="start"
        >
          <YourCharts rows={h.rows} />
          {all.count > 0 && (
            // Headed inside the card, as the canvas draws it.
            <s-section accessibilityLabel={heading}>
              <s-stack gap="base">
                <s-heading>{heading}</s-heading>
                <s-paragraph color="subdued">
                  {titles.length
                    ? "Shoppers on these pages can't check sizing."
                    : `All ${num(all)} products show a chart. New products get one when they match a display rule.`}
                </s-paragraph>
                {titles.length > 0 && (
                  <s-unordered-list>
                    {titles.map((t, i) => (
                      <s-list-item key={i}>{t}</s-list-item>
                    ))}
                  </s-unordered-list>
                )}
                <s-button href="/app/rules">
                  {titles.length
                    ? "Add a display rule"
                    : "Review display rules"}
                </s-button>
              </s-stack>
            </s-section>
          )}
        </s-grid>
      )}
    </>
  );
}

function PlanBanner({ plan, yearly, plansUrl, active, limit }: Ok) {
  const link = (
    <s-link href={plansUrl} target="_top">
      Change plan
    </s-link>
  );
  // After a downgrade: nothing was unpublished, and publishing needs fewer than the limit (§8).
  if (limit && active > limit)
    return (
      <s-banner
        tone="warning"
        heading={`${active} published charts, over Free's limit of ${limit}`}
      >
        <s-stack gap="small-200">
          <s-paragraph>
            {`They stay live. To publish another, set ${active - limit + 1} to Draft or move to Standard, $9 a month.`}
          </s-paragraph>
          {link}
        </s-stack>
      </s-banner>
    );
  if (limit)
    return (
      <s-banner
        tone="info"
        heading={`Free plan: ${active} of ${limit} published charts`}
      >
        <s-stack gap="small-200">
          <s-paragraph>
            {
              "Drafts don't count. To publish a 4th, set one to Draft or move to Standard, $9 a month."
            }
          </s-paragraph>
          {link}
        </s-stack>
      </s-banner>
    );
  // A paid plan with no known billing period, such as one cached before Fitted
  // recorded it: no price to state rather than a guess.
  if (plan !== "free" && yearly === null) return null;
  const heading = {
    free: "Free plan: 3 charts, CSV export, no watermark. No order fees on any plan.",
    standard: `Standard plan, ${yearly ? "$90 a year" : "$9 a month"}. No order fees, however many orders your store gets.`,
    pro: `Pro plan, ${yearly ? "$150 a year" : "$15 a month"}. No order fees.`,
  }[plan];
  return (
    <s-banner tone="info" heading={heading}>
      {link}
    </s-banner>
  );
}

// The canvas's status mark: solid Published, dashed Draft; an import's note links to the chart.
function Status({ row }: { row: HomeRow }) {
  const on = row.status === "ACTIVE";
  const mark = (color: string, dash: boolean) => (
    <svg width="16" height="2" aria-hidden="true">
      <path
        d="M0 1h16"
        stroke={color}
        strokeWidth="2"
        strokeDasharray={dash ? "4 3" : ""}
      />
    </svg>
  );
  const label = (color: string, text: string, dash: boolean) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      {mark(color, dash)}
      <span style={{ color, fontWeight: 600 }}>{text}</span>
    </span>
  );
  if (row.note)
    return (
      <s-link href={`/app/charts/${row.id.split("/").pop()}`}>
        {label("#161616", row.note, true)}
      </s-link>
    );
  return on
    ? label("#2448A8", "Published", false)
    : label("#3D4043", "Draft", true);
}

function YourCharts({ rows }: { rows: HomeRow[] }) {
  return (
    <s-section padding="none" accessibilityLabel="Your charts">
      <s-box padding="base">
        <s-grid gridTemplateColumns="1fr auto" alignItems="center">
          <s-heading>Your charts</s-heading>
          <s-link href="/app/charts">Manage</s-link>
        </s-grid>
      </s-box>
      <s-table variant="auto">
        <s-table-header-row>
          <s-table-header listSlot="primary">Chart</s-table-header>
          <s-table-header listSlot="labeled" format="numeric">
            Products
          </s-table-header>
          <s-table-header listSlot="inline">Status</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {rows.map((r) => (
            <s-table-row key={r.id}>
              <s-table-cell>
                <s-text type="strong">{r.name}</s-text>
              </s-table-cell>
              <s-table-cell>{num(r.products)}</s-table-cell>
              <s-table-cell>
                <Status row={r} />
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-section>
  );
}
