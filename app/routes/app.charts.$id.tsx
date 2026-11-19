// The chart editor: name, template, status, the size table and units, saved
// through the save bar (ARCHITECTURE §5, §15; the canvas's Editor board).
import { randomInt } from "node:crypto";
import { useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  SubmitTarget,
} from "react-router";
import {
  Link,
  data,
  useFetcher,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { AdminApiError } from "../models/admin.server";
import {
  ChartConflictError,
  ChartNotFoundError,
  ChartValidationError,
  type FieldErrors,
  type Template,
  countActiveCharts,
  createChart,
  getChart,
  publishChart,
  unpublishChart,
  updateChart,
  validateChart,
} from "../models/chart.server";
import { canPublishChart, getPlan } from "../models/billing.server";
import { ChartTable } from "../components/chart-table/ChartTable";
import {
  type Draft,
  MAX_COLUMNS,
  MAX_ROWS,
  addMeasurement,
  addSize,
  blankDraft,
  setUnit,
  setWord,
  toDraft,
  toInput,
} from "../components/chart-table/model";
import styles from "../components/chart-table/editor.css?url";

export const links = () => [{ rel: "stylesheet", href: styles }];

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
    return data({ mode: "error" as const }, { status: 502 });
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
      const { plan } = await getPlan(session.shop);
      if (!canPublishChart(plan, await countActiveCharts(admin)))
        return fail(
          403,
          "plan_limit",
          "Free includes 3 published charts. Nothing was saved: set this chart to Draft to save your changes, or upgrade to Standard to publish more.",
        );
    }
    const saved = await updateChart(admin, id, body.chart, body.updatedAt);
    if (saved.status === status) return { ok: true as const };
    try {
      await (status === "ACTIVE" ? publishChart : unpublishChart)(admin, id);
      return { ok: true as const };
    } catch (err) {
      if (!(err instanceof AdminApiError)) throw err;
      logShopifyError(session.shop, err);
      return fail(
        502,
        "status",
        `Your edits were saved, but the chart is still ${saved.status === "ACTIVE" ? "Published" : "a Draft"}. Change its status and save again.`,
      );
    }
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

type Result =
  | { ok: true }
  | { fieldErrors: FieldErrors }
  | { error: { code: string; message: string } };

const TEMPLATES: Record<Template, string> = {
  blank: "Blank",
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
const HEADINGS: Record<string, string> = {
  conflict: "This chart changed since you opened it",
  plan_limit: "This chart can't be published on Free",
  status: "The chart's status didn't change",
};

export default function ChartEditor() {
  const loaded = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  if (loaded.mode === "edit" && loaded.stored.chart)
    return (
      <Editor
        key={loaded.stored.id}
        initial={toDraft(loaded.stored.chart, loaded.stored.status)}
        version={`${loaded.stored.updatedAt}|${loaded.stored.status}`}
        updatedAt={loaded.stored.updatedAt}
      />
    );
  if (loaded.mode === "new")
    return <Editor key="new" initial={blankDraft()} handle={loaded.handle} />;
  return (
    <s-page>
      <div className="editor">
        <Link to="/app/charts">Size charts</Link>
        {revalidator.state === "loading" ? (
          <div role="status" aria-label="Loading chart">
            <span className="sk" style={{ height: 240 }} />
          </div>
        ) : (
          <>
            <s-banner
              tone="critical"
              heading={
                loaded.mode === "error"
                  ? "This chart didn't load"
                  : "This chart can't be opened"
              }
            >
              {loaded.mode === "error"
                ? "Fitted couldn't reach your store just now. Nothing about the chart has changed, and shoppers still see it as before."
                : "Its saved data didn't pass Fitted's checks, so the editor won't open it and risk losing anything. Shoppers don't see it until it's fixed."}
              <s-button
                slot="secondary-actions"
                onClick={() => revalidator.revalidate()}
              >
                Try again
              </s-button>
            </s-banner>
          </>
        )}
      </div>
    </s-page>
  );
}

function Editor({
  initial,
  version,
  updatedAt,
  handle,
}: {
  initial: Draft;
  version?: string;
  updatedAt?: string;
  handle?: string;
}) {
  const fetcher = useFetcher<Result>();
  const revalidator = useRevalidator();
  const [draft, setDraft] = useState(initial);
  const [notice, setNotice] = useState<Result | null>(null);
  // A save that wrote to Shopify reloads the chart: start over from what's stored.
  const [seen, setSeen] = useState({ version, data: fetcher.data });
  if (seen.version !== version || seen.data !== fetcher.data) {
    setSeen({ version, data: fetcher.data });
    if (seen.version !== version) setDraft(initial);
    if (seen.data !== fetcher.data) setNotice(fetcher.data ?? null);
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const saving = fetcher.state !== "idle";
  const errors = notice && "fieldErrors" in notice ? notice.fieldErrors : {};
  const t = draft.content.tables[0];
  const save = () => {
    const r = toInput(draft);
    if ("fieldErrors" in r) return setNotice(r);
    setNotice(null);
    fetcher.submit(
      handle
        ? ({ handle, chart: r.input } as unknown as SubmitTarget)
        : ({
            chart: r.input,
            status: draft.status,
            updatedAt,
          } as unknown as SubmitTarget),
      { method: "post", encType: "application/json" },
    );
  };
  const other = Object.entries(errors).filter(
    ([k]) =>
      k !== "name" &&
      !k.startsWith(`content.words.${t.id}.`) &&
      !k.startsWith("content.tables.0.rows."),
  );
  const failed = notice && "error" in notice ? notice.error : null;
  return (
    <s-page>
      <SaveBar id="chart-save-bar" open={dirty}>
        <button
          variant="primary"
          onClick={save}
          loading={saving ? "" : undefined}
        >
          Save
        </button>
        <button
          onClick={() => {
            setDraft(initial);
            setNotice(null);
          }}
          disabled={saving}
        >
          Discard
        </button>
      </SaveBar>
      <div className="editor">
        {notice && !("ok" in notice) && (
          <s-banner
            tone="critical"
            heading={
              (failed && HEADINGS[failed.code]) || "Your changes weren't saved"
            }
          >
            {failed?.message ??
              "Fix the fields marked in red, then save again."}
            {other.map(([k, m]) => (
              <div key={k}>{m}</div>
            ))}
            {failed?.code === "conflict" ? (
              <s-button
                slot="secondary-actions"
                onClick={() => revalidator.revalidate()}
              >
                Reload chart
              </s-button>
            ) : failed?.code === "shopify" ? (
              <s-button slot="secondary-actions" onClick={save}>
                Try saving again
              </s-button>
            ) : null}
          </s-banner>
        )}
        <div className="row">
          <div>
            <Link to="/app/charts">Size charts</Link>
            <div className="row" style={{ justifyContent: "flex-start" }}>
              <h1>{handle ? "New chart" : initial.name}</h1>
              {!handle && (
                <select
                  className="field"
                  aria-label="Chart status"
                  style={{ width: "auto" }}
                  value={draft.status}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      status: e.target.value as Draft["status"],
                    })
                  }
                >
                  <option value="ACTIVE">Published</option>
                  <option value="DRAFT">Draft</option>
                </select>
              )}
            </div>
          </div>
        </div>
        <section className="card" aria-label="Chart content">
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div style={{ flex: "2 1 220px" }}>
              <label className="lbl" htmlFor="name">
                Chart name
              </label>
              <input
                id="name"
                className={errors.name ? "field bad" : "field"}
                placeholder="For example, Women's tops"
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? "name-err" : undefined}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              {errors.name && (
                <p id="name-err" className="err">
                  {errors.name}
                </p>
              )}
            </div>
            <div style={{ flex: "1 1 160px" }}>
              <label className="lbl" htmlFor="tpl">
                Template
              </label>
              <select
                id="tpl"
                className="field"
                value={draft.template}
                onChange={(e) =>
                  setDraft({ ...draft, template: e.target.value as Template })
                }
              >
                {Object.entries(TEMPLATES).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="row">
            <div role="group" aria-label="Units" className="seg-group">
              {(["in", "cm"] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  className="seg"
                  aria-pressed={draft.content.unit === u}
                  onClick={() => setDraft(setUnit(draft, u))}
                >
                  {u}
                </button>
              ))}
            </div>
            <s-button-group>
              <s-button
                disabled={t.rows.length >= MAX_ROWS}
                onClick={() => setDraft(addSize(draft))}
              >
                Add size
              </s-button>
              <s-button
                disabled={t.columns.length >= MAX_COLUMNS}
                onClick={() => setDraft(addMeasurement(draft))}
              >
                Add measurement
              </s-button>
            </s-button-group>
          </div>
          {t.rows.length ? (
            <ChartTable draft={draft} errors={errors} onChange={setDraft} />
          ) : (
            <div className="blank">
              <h2 style={{ margin: 0, fontSize: 16 }}>
                A blank chart, ready for sizes
              </h2>
              <p className="help">
                Add a size and a measurement to start, then type your numbers.
              </p>
              {errors["content.tables.0.rows"] && (
                <p className="err">{errors["content.tables.0.rows"]}</p>
              )}
            </div>
          )}
          <p className="help">
            Type in inches or centimeters. Fitted converts the other unit for
            shoppers automatically.
          </p>
          <div>
            <label className="lbl" htmlFor="note">
              Note under the table
            </label>
            <textarea
              id="note"
              className="field"
              rows={2}
              style={{ padding: "8px 10px", minHeight: 64 }}
              value={draft.content.words[`${t.id}.note`] ?? ""}
              onChange={(e) =>
                setDraft(setWord(draft, `${t.id}.note`, e.target.value))
              }
            />
          </div>
        </section>
      </div>
    </s-page>
  );
}
