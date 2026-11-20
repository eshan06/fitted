// Fit finder (ARCHITECTURE §7, §8, §10, §15): the FitFinder board, saved
// through App Bridge's save bar: its settings to `$app.settings`, and each
// chart's ease and stretch to that chart's `content.fit`. Set up on any plan;
// it goes live on Pro.
import { Suspense, useState, type ReactNode } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Await,
  data,
  useFetcher,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  type Admin,
  AdminApiError,
  pricingPlansUrl,
} from "../models/admin.server";
import {
  ChartConflictError,
  ChartNotFoundError,
  ChartValidationError,
  type StoredChart,
  chartPages,
  getChart,
  updateChart,
  validateChart,
} from "../models/chart.server";
import { STRETCH, type Fit } from "../lib/fit-finder";
import {
  type FitChart,
  describe,
  formatEase,
  parseEase,
} from "../components/fit-finder/chart-fit";
import { getPlan } from "../models/billing.server";
import {
  type FieldErrors,
  type Settings,
  SettingsConflictError,
  SettingsReadWriteError,
  SettingsValidationError,
  getSettings,
  saveSettings,
} from "../models/settings.server";
import { Banner } from "../components/rules/RulesEditor";
import "../components/chart-table/editor.css";
import "../components/appearance/appearance.css";
import "../components/fit-finder/fit-finder.css";

const ROUTE = "app.fit-finder";
const log = (shop: string, err: Error) =>
  console.log(
    JSON.stringify({ level: "error", msg: err.message, shop, route: ROUTE }),
  );

// The canvas's words: a heading, then its lines; "**" marks the bold one.
const COPY: Record<string, string[]> = {
  load: [
    "Your fit finder settings didn't load",
    "Fitted couldn't reach your store just now. Nothing has changed for shoppers.",
  ],
  // Not drawn yet (#128): the server's line names what saved and what didn't (§15).
  partial: ["Only some of your fit finder changes were saved"],
  conflict: [
    "Fit finder settings changed since you opened them",
    "Your edits weren't saved, so nothing was overwritten.",
    "**Reload latest shows the newest settings and discards your edits.",
  ],
  shopify: [
    "Your fit finder changes weren't saved",
    "Shopify didn't respond in time, so nothing changed for shoppers. Your edits are still here.",
  ],
};
const refusal = (code: string) => ({
  error: { code, message: COPY[code].slice(1).join(" ").replace("**", "") },
});

// Only a chart with `content.fit` has questions to show (§10).
const fitChart = ({ id, updatedAt, name, chart }: StoredChart): FitChart[] => {
  const c = chart?.content;
  const table = c?.tables.find((t) => t.id === c.fit?.table);
  if (!c?.fit || !table) return [];
  const words = Object.entries(c.words).filter(
    ([k]) => k.startsWith(`${table.id}.`) || k.startsWith("fit."),
  );
  const { unit, fit } = c;
  return [
    { id, updatedAt, name, unit, fit, table, words: Object.fromEntries(words) },
  ];
};

async function load(admin: Admin, shop: string) {
  try {
    const all: StoredChart[] = [];
    const [settings, { plan }, plansUrl] = await Promise.all([
      getSettings(admin),
      getPlan(shop),
      pricingPlansUrl(admin, shop),
      (async () => {
        for await (const page of chartPages(admin)) all.push(...page);
      })(),
    ]);
    const charts = all.flatMap(fitChart);
    return { ...settings, plan, plansUrl, hasCharts: all.length > 0, charts };
  } catch (err) {
    if (!(
      err instanceof SettingsReadWriteError || err instanceof AdminApiError
    ))
      throw err;
    log(shop, err);
    return refusal("load");
  }
}
type Ok = Exclude<Awaited<ReturnType<typeof load>>, { error: unknown }>;

// Streamed, so the screen shows its loading state while Shopify answers.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  return {
    fitFinder: load(admin, session.shop),
    storeUrl: `https://${session.shop}`,
  };
};

// The screen sends the fit finder section whole, with the primary language's
// "When no size fits", and the ease and stretch of each chart it changed.
// Everything else stays as stored. A part already holding what was sent (a
// retry after a partial save) is skipped, so a retry never reads as stale.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = await request.json().catch(() => null);
  const done: string[] = []; // what saved, for a partial save's report
  const left: string[] = [];
  try {
    // Only the digest and the edits come from the browser (§3).
    const loaded = await getSettings(admin);
    const { settings: s, primaryLocale: l } = loaded;
    const e = body?.edits ?? {};
    const input = {
      ...s,
      fitFinder: e.fitFinder,
      text: { ...s.text, [l]: { ...s.text[l], noFit: e.noFit } },
    };
    // Every chart is checked before anything is written.
    const writes: [string, () => Promise<unknown>][] = [];
    const sent = Array.isArray(body?.charts) ? body.charts.slice(0, 200) : [];
    const seen = new Set();
    for (const { id, updatedAt, ease, stretch } of sent.map(Object)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const { chart, updatedAt: now } = await getChart(admin, id);
      const fit = chart?.content.fit;
      if (!fit) throw new ChartConflictError("The chart lost its questions");
      const next = validateChart({
        ...chart,
        content: { ...chart.content, fit: { ...fit, ease, stretch } },
      });
      const key = (e: object) => JSON.stringify(Object.entries(e).sort());
      if (stretch === fit.stretch && key(ease) === key(fit.ease)) continue;
      // The chart's own conflict check (§5), here and again at its write.
      if (now !== updatedAt)
        throw new ChartConflictError("This chart changed since you opened it");
      writes.push([chart.name, () => updateChart(admin, id, next, updatedAt)]);
    }
    const digest = typeof body?.digest === "string" ? body.digest : null;
    left.push(...writes.map(([name]) => name));
    if (JSON.stringify(input) !== JSON.stringify(s)) {
      await saveSettings(admin, { ...loaded, digest }, input);
      done.push("Your settings");
    }
    for (const [, write] of writes) {
      await write();
      done.push(left.shift()!);
    }
    return { ok: true as const };
  } catch (err) {
    if (done.length && err instanceof Error) {
      log(session.shop, err);
      const message = `${done.join(", ")} saved, but ${left.join(", ")} didn't, so ${left.length > 1 ? "those aren't" : "that isn't"} live yet. Your edits are still here: try saving again to finish.`;
      return data({ error: { code: "partial", message } }, { status: 502 });
    }
    if (
      err instanceof SettingsValidationError ||
      err instanceof ChartValidationError
    ) {
      // Words and ease go by the screen's names.
      const fieldErrors: FieldErrors = {};
      for (const [path, message] of Object.entries(err.fieldErrors))
        fieldErrors[
          path
            .replace(/^text\.[^.]+\.noFit$/, "noFit")
            .replace(/^content\.fit\.ease(\..*)?$/, "ease")
        ] = message;
      return data({ fieldErrors }, { status: 422 });
    }
    if (
      err instanceof SettingsConflictError ||
      err instanceof ChartConflictError ||
      err instanceof ChartNotFoundError
    )
      return data(refusal("conflict"), { status: 409 });
    if (!(
      err instanceof SettingsReadWriteError || err instanceof AdminApiError
    ))
      throw err;
    log(session.shop, err);
    return data(refusal("shopify"), { status: 502 });
  }
};

// The FitFinder board's states: loading, couldn't load, no charts yet, set up.
export default function FitFinder() {
  const { fitFinder, storeUrl } = useLoaderData<typeof loader>();
  return (
    <Suspense fallback={<Page body={<Loading />} />}>
      <Await resolve={fitFinder} errorElement={<Page body={<LoadError />} />}>
        {(f) =>
          "error" in f ? (
            <Page body={<LoadError />} />
          ) : !f.hasCharts ? (
            <Page body={<Empty />} />
          ) : (
            <Editor
              key={[f.digest, ...f.charts.map((c) => c.updatedAt)].join()}
              loaded={f}
              storeUrl={storeUrl}
            />
          )
        }
      </Await>
    </Suspense>
  );
}

const Page = (props: {
  banners?: ReactNode;
  action?: ReactNode;
  body: ReactNode;
}) => (
  <s-page>
    {/* Shares Appearance's form styles. */}
    <div className="editor appearance fit-finder">
      {props.banners}
      <div className="row">
        <div>
          <div className="title">
            <h1>Fit finder</h1>
            <span className="pro">Pro</span>
          </div>
          <p className="help">
            Ask shoppers a few quick questions and recommend a size from your
            chart.
          </p>
        </div>
        {props.action}
      </div>
      {props.body}
    </div>
  </s-page>
);

const Loading = () => (
  <div role="status" className="editor">
    <span className="visually-hidden">Loading fit finder settings</span>
    {[3, 4, 7].map((rows) => (
      <div key={rows} className="card">
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className="sk" style={{ width: `${90 - i * 9}%` }} />
        ))}
      </div>
    ))}
  </div>
);

const button = (label: string, onClick: () => void) => (
  <s-button slot="secondary-actions" onClick={onClick}>
    {label}
  </s-button>
);

function LoadError() {
  const revalidator = useRevalidator();
  if (revalidator.state === "loading") return <Loading />;
  return (
    <>
      <Banner copy={COPY.load}>
        {button("Try again", () => revalidator.revalidate())}
      </Banner>
      <p className="help">
        Still not working? Email [SUPPORT EMAIL] and we&apos;ll look into it.
      </p>
    </>
  );
}

const Empty = () => (
  <section className="card empty" aria-labelledby="h-empty">
    <svg
      width="56"
      height="56"
      viewBox="0 0 48 48"
      fill="none"
      stroke="#2448A8"
      strokeLinecap="square"
      aria-hidden="true"
    >
      <path d="M10 40V10h30" strokeWidth="3" strokeDasharray="4 3" />
      <path d="M17 40V17h23" strokeWidth="6" />
      <path d="M24 40V24h16" strokeWidth="3" />
    </svg>
    <h2 id="h-empty">Nothing to measure against yet</h2>
    <p className="help">
      The fit finder picks sizes from your size charts, so it needs one first.
      Add a chart and you can write the questions here.
    </p>
    <s-button variant="primary" href="/app/charts/new">
      Create chart
    </s-button>
    <p className="help">Fit finder is part of Pro, $15 a month.</p>
  </section>
);

type Answer = {
  ok?: true;
  fieldErrors?: FieldErrors;
  error?: { code: string; message: string };
};
type Draft = {
  fitFinder: Settings["fitFinder"];
  noFit: string;
  fits: Record<string, { ease: string; stretch: Fit["stretch"] }>; // by chart id
};
type Flag = keyof Omit<Settings["fitFinder"], "type" | "answers">;
const PLAN_NAMES = { free: "Free", standard: "Standard", pro: "Pro" };
const NO_FIT = "Enter a message for shoppers, up to 200 characters.";
// Keyed by the engine's STRETCH, so the choices can't drift from it.
const STRETCH_NAMES: Record<keyof typeof STRETCH, string> = {
  none: "None",
  some: "Some (linen blend)",
  high: "High",
};
// The fix list's words for each marked field, in the canvas's order.
const MARKS: Record<string, [string, string]> = {
  ease: ["Ease", "doesn't start with a number"],
  noFit: ["When no size fits", "is empty"],
};
const errorLine = (id: string, words: string) => (
  <p id={`${id}-err`} className="help err">
    <s-icon type="alert-circle" tone="critical" size="small" />
    {words}
  </p>
);

function Editor({ loaded, storeUrl }: { loaded: Ok; storeUrl: string }) {
  const fetcher = useFetcher<Answer>();
  const revalidator = useRevalidator();
  const [initial] = useState<Draft>(() => ({
    fitFinder: loaded.settings.fitFinder,
    noFit: loaded.settings.text[loaded.primaryLocale].noFit,
    fits: Object.fromEntries(
      loaded.charts.map((c) => [
        c.id,
        { ease: formatEase(c), stretch: c.fit.stretch },
      ]),
    ),
  }));
  const [chartId, setChartId] = useState(loaded.charts[0]?.id);
  const chart = loaded.charts.find((c) => c.id === chartId);
  const [draft, setDraft] = useState(initial);
  const [local, setLocal] = useState<Answer | null>(null);
  const [dismissed, setDismissed] = useState<Answer>();
  const saving = fetcher.state !== "idle";
  const answer = saving ? undefined : fetcher.data;
  const notice = local ?? (answer === dismissed ? undefined : answer);
  const errors = notice?.fieldErrors ?? {};
  const marked = Object.keys(errors);
  const code = notice?.error?.code;

  const save = () => {
    const fieldErrors: FieldErrors = {};
    const charts = [];
    for (const c of loaded.charts) {
      const { ease: text, stretch } = draft.fits[c.id];
      const was = initial.fits[c.id];
      if (text === was.ease && stretch === was.stretch) continue;
      const ease = text === was.ease ? c.fit.ease : parseEase(c, text);
      if (!ease) {
        fieldErrors.ease = "Missing";
        setChartId(c.id);
        break;
      }
      charts.push({ id: c.id, updatedAt: c.updatedAt, ease, stretch });
    }
    if (!draft.noFit.trim()) fieldErrors.noFit = "Missing";
    if (Object.keys(fieldErrors).length) return setLocal({ fieldErrors });
    setLocal(null);
    const edits = { fitFinder: draft.fitFinder, noFit: draft.noFit };
    fetcher.submit({ digest: loaded.digest, edits, charts } as never, {
      method: "post",
      encType: "application/json",
    });
  };
  const dismiss = () => {
    setLocal(null);
    setDismissed(answer);
  };
  const put = (patch: Partial<Draft["fitFinder"]>) =>
    setDraft((d) => ({ ...d, fitFinder: { ...d.fitFinder, ...patch } }));
  const f = draft.fitFinder;
  const own = chart && draft.fits[chart.id];
  const putFit = (patch: Partial<Draft["fits"][string]>) =>
    setDraft((d) => ({
      ...d,
      fits: { ...d.fits, [chart!.id]: { ...d.fits[chart!.id], ...patch } },
    }));
  const box = (id: Flag, label: string) => (
    <label className="choice">
      <input
        type="checkbox"
        checked={f[id]}
        onChange={(e) => put({ [id]: e.target.checked })}
      />
      {label}
    </label>
  );
  const type = (v: Draft["fitFinder"]["type"], name: string, help: string) => (
    <label>
      <input
        type="radio"
        name="type"
        checked={f.type === v}
        onChange={() => put({ type: v })}
      />
      <strong>{name}</strong>
      <span className="help">{help}</span>
    </label>
  );

  const banners = (
    <>
      {code === "conflict" ? (
        <Banner copy={COPY.conflict}>
          {button("Reload latest", () => revalidator.revalidate())}
          {button("Cancel", dismiss)}
        </Banner>
      ) : (
        code && (
          <Banner
            copy={
              code === "partial"
                ? [...COPY.partial, notice!.error!.message]
                : COPY.shopify
            }
          >
            {button("Try saving again", save)}
          </Banner>
        )
      )}
      {marked.length > 0 && (
        <Banner
          copy={[
            `Fix ${marked.length} field${marked.length === 1 ? "" : "s"} to save`,
            "Nothing was saved, so your store hasn't changed.",
          ]}
        >
          <ul className="list">
            {marked.map((id) => (
              <li key={id}>
                {MARKS[id] ? (
                  <>
                    <a
                      href={`#${id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(id)?.focus();
                      }}
                    >
                      {MARKS[id][0]}
                    </a>{" "}
                    {MARKS[id][1]}
                  </>
                ) : (
                  `${id}: ${errors[id]}`
                )}
              </li>
            ))}
          </ul>
        </Banner>
      )}
    </>
  );

  return (
    <>
      <SaveBar
        id="fit-finder-save-bar"
        open={saving || JSON.stringify(draft) !== JSON.stringify(initial)}
      >
        <button
          variant="primary"
          onClick={save}
          loading={saving ? "" : undefined}
        >
          Save
        </button>
        <button
          disabled={saving}
          onClick={() => {
            setDraft(initial);
            dismiss();
          }}
        >
          Discard
        </button>
      </SaveBar>
      <Page
        banners={banners}
        action={
          <s-button href={storeUrl} target="_blank">
            Preview on your store
          </s-button>
        }
        body={
          <>
            {loaded.plan !== "pro" && (
              <Banner
                tone="info"
                copy={[
                  `Fit finder is part of Pro, $15 a month. You're on ${PLAN_NAMES[loaded.plan]}: set it up now and it goes live when you upgrade.`,
                ]}
              >
                <s-button
                  slot="secondary-actions"
                  href={loaded.plansUrl}
                  target="_top"
                >
                  Upgrade to Pro
                </s-button>
              </Banner>
            )}

            <section className="card" aria-labelledby="h-type">
              <h2 id="h-type">Fit finder type</h2>
              <div className="types">
                {type(
                  "basic",
                  "Basic",
                  "Height, weight, age and fit preference. No tape measure needed.",
                )}
                {type(
                  "advanced",
                  "Advanced",
                  "Body measurements, with ease and stretch set per garment.",
                )}
                {type(
                  "custom",
                  "Custom",
                  "Your own questions and rules, from hats to dog coats.",
                )}
              </div>
              <div className="fields">
                <label>
                  Answer style
                  <select
                    className="field"
                    value={f.answers}
                    onChange={(e) =>
                      put({ answers: e.target.value as typeof f.answers })
                    }
                  >
                    <option value="inputs">Input boxes</option>
                    <option value="sliders">Sliders</option>
                  </select>
                </label>
                {own && (
                  <>
                    <div>
                      <label>
                        Ease
                        <input
                          id="ease"
                          className={errors.ease ? "field bad" : "field"}
                          aria-invalid={errors.ease ? true : undefined}
                          aria-describedby={
                            errors.ease ? "ease-err" : undefined
                          }
                          value={own.ease}
                          onChange={(e) => putFit({ ease: e.target.value })}
                        />
                      </label>
                      {errors.ease &&
                        errorLine(
                          "ease",
                          "Start with a number, like +2 in at bust.",
                        )}
                    </div>
                    <label>
                      Stretch
                      <select
                        className="field"
                        value={own.stretch}
                        onChange={(e) =>
                          putFit({
                            stretch: e.target.value as Fit["stretch"],
                          })
                        }
                      >
                        {Object.entries(STRETCH_NAMES).map(([v, name]) => (
                          <option key={v} value={v}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
              </div>
            </section>

            {chart && (
              <section className="card" aria-labelledby="h-qs">
                <div className="row">
                  <h2 id="h-qs">Questions</h2>
                  <label>
                    Recommend sizes from
                    <select
                      className="field"
                      value={chart.id}
                      onChange={(e) => setChartId(e.target.value)}
                    >
                      {loaded.charts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <ol className="qs">
                  {chart.fit.questions.map((q, i) => {
                    const d = describe(chart, q);
                    return (
                      <li key={q.id}>
                        <span className="num" aria-hidden="true">
                          {i + 1}
                        </span>
                        <span>
                          <strong>{d.words}</strong>
                          <span className="help">{d.kind}</span>
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}

            <section className="card" aria-labelledby="h-result">
              <h2 id="h-result">Result screen</h2>
              {box(
                "fitBars",
                "Show fit bars, tight to loose, for each measurement",
              )}
              {box("otherSizes", "Let shoppers see how other sizes would fit")}
              {box(
                "addToCart",
                "Add the recommended size to cart from the result",
              )}
              {box("onButton", "Show the result on the product page button")}
              {box(
                "similar",
                "Suggest similar products when the size is sold out",
              )}
              {box("note", "Show a note on how measurements are used")}
              {box("askAge", "Ask for age (Basic only)")}
              <div>
                <label>
                  When no size fits
                  <input
                    id="noFit"
                    className={errors.noFit ? "field bad" : "field"}
                    aria-invalid={errors.noFit ? true : undefined}
                    aria-describedby={errors.noFit ? "noFit-err" : undefined}
                    maxLength={200}
                    value={draft.noFit}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, noFit: e.target.value }))
                    }
                  />
                </label>
                {errors.noFit && errorLine("noFit", NO_FIT)}
              </div>
            </section>
          </>
        }
      />
    </>
  );
}
