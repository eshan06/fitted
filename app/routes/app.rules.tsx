// Display rules (ARCHITECTURE §6, §13, §15): load the rules and every chart,
// save the rules, and start the resolve that applies them.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, data, useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import {
  AdminApiError,
  canReadProducts,
  pricingPlansUrl,
} from "../models/admin.server";
import { getPlan } from "../models/billing.server";
import { chartPages, countChartProducts } from "../models/chart.server";
import {
  RulesConflictError,
  RulesPlanError,
  RulesValidationError,
  StoredRulesError,
  chartPreview,
  countProducts,
  getRules,
  latestResolve,
  pickedNames,
  saveRules,
  startResolve,
} from "../models/rules.server";
import { Banner, COPY, RulesEditor } from "../components/rules/RulesEditor";
import { storedProblems } from "../components/rules/model";
import "../components/chart-table/editor.css";

const log = (shop: string, err: AdminApiError) =>
  console.log(
    JSON.stringify({
      level: "error",
      msg: err.message,
      shop,
      route: "app.rules",
      detail: err.detail,
    }),
  );

// What the screen does without (a count, a link): logged, never shown (§15).
const optional = <T,>(shop: string, p: Promise<T>) =>
  p.catch((err) => {
    if (!(err instanceof AdminApiError)) throw err;
    log(shop, err);
    return null;
  });

// The resolve's progress is app-only state (§13): a failed read is logged and
// the screen carries on without it.
const readJob = (shop: string) =>
  latestResolve(shop).catch((err: unknown) => {
    console.log(
      JSON.stringify({
        level: "error",
        msg: "Couldn't read the resolve job",
        shop,
        route: "app.rules",
        detail: String(err),
      }),
    );
    return "failed" as const;
  });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop } = session;
  // The screen polls this while a resolve runs, and retries a failed read.
  if (new URL(request.url).searchParams.has("job")) {
    const job = await readJob(shop);
    return job === "failed"
      ? data({ mode: "job" as const, job: null, failed: true }, { status: 503 })
      : { mode: "job" as const, job };
  }
  // The matches card of the chart on screen.
  const id = new URL(request.url).searchParams.get("preview");
  if (id !== null)
    try {
      const preview = await optional(shop, chartPreview(admin, shop, id));
      return { mode: "preview" as const, preview };
    } catch (err) {
      if (!(err instanceof RulesValidationError)) throw err;
      return data({ mode: "preview" as const, preview: null }, { status: 400 });
    }
  try {
    const charts = [];
    for await (const page of chartPages(admin))
      charts.push(...page.map((c) => ({ id: c.id, name: c.name })));
    if (!charts.length) return { mode: "empty" as const };
    const [read, products, counts, { plan }] = await Promise.all([
      readJob(shop),
      // Staff without Products access can't count them.
      optional(shop, countProducts(admin)),
      optional(
        shop,
        countChartProducts(
          admin,
          charts.map((c) => c.id),
        ),
      ),
      getPlan(shop),
    ]);
    const free = plan === "free";
    const plansUrl = free
      ? await optional(shop, pricingPlansUrl(admin, shop))
      : null;
    const base = {
      mode: "edit" as const,
      charts,
      job: read === "failed" ? null : read,
      unread: read === "failed", // the screen polls until it reads one
      products,
      counts,
      free,
      plansUrl,
    };
    try {
      const { rules, digest } = await getRules(admin);
      // Without them, picks show as a count.
      const names = await optional(shop, pickedNames(admin, rules));
      return { ...base, rules, digest, damaged: null, names: names ?? {} };
    } catch (err) {
      if (!(err instanceof StoredRulesError)) throw err;
      // A valid save with this digest replaces them (§6).
      const rules = { v: 1 as const, order: [], charts: {} };
      const damaged = storedProblems(err.fieldErrors, err.value, charts);
      return { ...base, rules, digest: err.digest, damaged, names: {} };
    }
  } catch (err) {
    if (!(err instanceof AdminApiError)) throw err;
    log(shop, err);
    const error = { code: "shopify", message: COPY.load[1] };
    return data({ mode: "error" as const, error }, { status: 502 });
  }
};

// The answers of §15, worded as the screen's banners.
const fail = (status: number, code: string, more?: object) =>
  data({ error: { code, message: COPY[code][1] }, ...more }, { status });

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop } = session;
  const body = await request.json().catch(() => null);
  let checkFailed = false;
  try {
    // The resolve runs with the offline token, so staff without Products access can't start one (§13).
    if (!(await canReadProducts(admin))) return fail(403, "product_access");
    // Try again after a resolve that didn't finish applies the saved rules.
    if (body?.intent !== "apply") {
      const got = await getPlan(shop);
      checkFailed = got.checkFailed;
      await saveRules(admin, body?.rules, body?.digest, got.plan);
    }
    // The screen shows the rules applying until a job newer than this one ends;
    // unread, any job created from now on is newer (Prisma stamps `createdAt`
    // with the app's clock).
    const read = await readJob(shop);
    const after = read === "failed" ? Date.now() - 1 : (read?.at ?? 0);
    // Every product follows, `auto: false` charts included (§6).
    void startResolve(shop, true);
    return { ok: true as const, after };
  } catch (err) {
    if (err instanceof RulesValidationError)
      return data({ fieldErrors: err.fieldErrors }, { status: 422 });
    // Free's refusal marks its conditions like a check does, with the upgrade (§8).
    if (err instanceof RulesPlanError) {
      const plansUrl = await optional(shop, pricingPlansUrl(admin, shop));
      const fieldErrors = err.fieldErrors;
      return fail(403, "plan", { fieldErrors, checkFailed, plansUrl });
    }
    if (err instanceof RulesConflictError) return fail(409, "conflict");
    if (!(err instanceof AdminApiError)) throw err;
    log(shop, err);
    return fail(502, "shopify");
  }
};

// The Rules board's states around the editor: loading, no charts yet and
// couldn't load.
export default function DisplayRules() {
  const loaded = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const heading = (
    <div>
      <h1>Display rules</h1>
      <p className="help">
        Choose which products show each chart. New products are picked up
        automatically.
      </p>
    </div>
  );
  let body;
  if (revalidator.state === "loading" && loaded.mode !== "edit")
    body = (
      <div role="status" className="card">
        <span className="visually-hidden">Loading display rules</span>
        <span className="sk" />
        <span className="sk short" />
      </div>
    );
  else if (loaded.mode === "edit")
    return <RulesEditor loaded={loaded} heading={heading} />;
  else if (loaded.mode === "empty")
    body = (
      <section className="card empty" aria-labelledby="empty">
        <h2 id="empty">Rules need a chart to point at</h2>
        <p className="help">
          Display rules decide which products show each chart. Make your first
          chart, then come back and match it to collections, tags or product
          types.
        </p>
        <Link className="button" to="/app/charts/new">
          Create chart
        </Link>
        <p className="help">
          Moving from Kiwi? <Link to="/app/import">Import your charts</Link>{" "}
          instead.
        </p>
      </section>
    );
  else
    body = (
      <>
        <Banner copy={COPY.load}>
          <s-button
            slot="secondary-actions"
            onClick={() => revalidator.revalidate()}
          >
            Try again
          </s-button>
        </Banner>
        <p className="help">
          Still not working? Email [SUPPORT EMAIL] and we&apos;ll look into it.
        </p>
      </>
    );
  return (
    <s-page>
      <div className="editor">
        {heading}
        {body}
      </div>
    </s-page>
  );
}
