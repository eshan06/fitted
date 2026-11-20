// Display rules (ARCHITECTURE §6, §13, §15): load the rules and every chart,
// save the rules, and start the resolve that applies them.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, data, useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import { AdminApiError, canReadProducts } from "../models/admin.server";
import { getPlan } from "../models/billing.server";
import { chartPages } from "../models/chart.server";
import {
  RulesConflictError,
  RulesPlanError,
  RulesValidationError,
  StoredRulesError,
  getRules,
  saveRules,
  startResolve,
} from "../models/rules.server";
import { Banner, COPY, RulesEditor } from "../components/rules/RulesEditor";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  try {
    const charts = [];
    for await (const page of chartPages(admin))
      charts.push(...page.map((c) => ({ id: c.id, name: c.name })));
    if (!charts.length) return { mode: "empty" as const };
    const base = { mode: "edit" as const, charts };
    try {
      const { rules, digest } = await getRules(admin);
      return { ...base, rules, digest, damaged: null };
    } catch (err) {
      if (!(err instanceof StoredRulesError)) throw err;
      // A valid save with this digest replaces them (§6).
      const rules = { v: 1 as const, order: [], charts: {} };
      return { ...base, rules, digest: err.digest, damaged: err.fieldErrors };
    }
  } catch (err) {
    if (!(err instanceof AdminApiError)) throw err;
    log(session.shop, err);
    return data({ mode: "error" as const }, { status: 502 });
  }
};

const fail = (status: number, code: string) =>
  data({ error: { code } }, { status });

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = await request.json().catch(() => null);
  try {
    // The resolve runs with the offline token, so staff without Products access can't start one (§13).
    if (!(await canReadProducts(admin))) return fail(403, "product_access");
    const { plan } = await getPlan(session.shop);
    await saveRules(admin, body?.rules, body?.digest, plan);
    // Every product follows, `auto: false` charts included (§6).
    void startResolve(session.shop, true);
    return { ok: true as const };
  } catch (err) {
    // A Free plan's refusal names its conditions like a check does (§8).
    if (err instanceof RulesValidationError || err instanceof RulesPlanError)
      return data(
        { fieldErrors: err.fieldErrors },
        { status: err instanceof RulesPlanError ? 403 : 422 },
      );
    if (err instanceof RulesConflictError) return fail(409, "conflict");
    if (!(err instanceof AdminApiError)) throw err;
    log(session.shop, err);
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
