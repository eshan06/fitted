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
  countChartProducts,
  getChart,
  updateChart,
  validateChart,
} from "../models/chart.server";
import { STRETCH, type Fit, type Question, findSize } from "../lib/fit-finder";
import {
  type FitChart,
  describe,
  fitOf,
  fitWords,
  formatEase,
  howItPicks,
  lastStep,
  parseEase,
  reasonText,
  sampleAnswers,
  size,
} from "../components/fit-finder/chart-fit";
import { QuestionEditor } from "../components/fit-finder/QuestionEditor";
import {
  getPlan,
  lastConfirmedPlan,
  type Plan,
} from "../models/billing.server";
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

// Every chart that reads, with its fit; one without questions yet gets them
// from the question editor (§10).
const fitChart = ({ id, updatedAt, name, chart }: StoredChart): FitChart[] => {
  const c = chart?.content;
  if (!c) return [];
  const fit = fitOf(c);
  const table = c.tables.find((t) => t.id === fit.table)!;
  const words = Object.entries(c.words).filter(
    ([k]) => k.startsWith(`${table.id}.`) || k.startsWith("fit."),
  );
  const { unit } = c;
  return [
    { id, updatedAt, name, unit, fit, table, words: Object.fromEntries(words) },
  ];
};

const listCharts = async (admin: Admin) => {
  const all: StoredChart[] = [];
  for await (const page of chartPages(admin)) all.push(...page);
  return all;
};

// Only Pro's live line names how many products show the picked chart, and
// only a chart with saved questions is live. A failed count is that line's
// own error, so the rest of the screen stays and can be saved.
async function liveCounts(
  admin: Admin,
  shop: string,
  plan: string,
  charts: FitChart[],
) {
  const live = charts.filter((c) => c.fit.questions.length);
  if (plan !== "pro" || !live.length) return null;
  try {
    return await countChartProducts(
      admin,
      live.map((c) => c.id),
    );
  } catch (err) {
    if (!(err instanceof AdminApiError)) throw err;
    log(shop, err);
    return "error" as const;
  }
}

async function load(admin: Admin, shop: string, plan: Plan) {
  try {
    const [settings, plansUrl, all] = await Promise.all([
      getSettings(admin),
      pricingPlansUrl(admin, shop),
      listCharts(admin),
    ]);
    const charts = all.flatMap(fitChart);
    const counts = await liveCounts(admin, shop, plan, charts);
    const hasCharts = all.length > 0;
    return { ...settings, plan, plansUrl, hasCharts, charts, counts };
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

// The live line's Try again: the count alone, so the screen keeps its edits.
// A failed count answers 502 (§15).
async function recount(admin: Admin, shop: string) {
  let counts: Ok["counts"] = "error";
  try {
    const [{ plan }, all] = await Promise.all([
      getPlan(shop),
      listCharts(admin),
    ]);
    counts = await liveCounts(admin, shop, plan, all.flatMap(fitChart));
  } catch (err) {
    if (!(err instanceof AdminApiError)) throw err;
    log(shop, err);
  }
  if (counts !== "error") return { counts };
  const error = { code: "count", message: "Fitted couldn't count them." };
  return data({ counts, error }, { status: 502 });
}
type Recount = { counts: Ok["counts"] };
type Screen = { fitFinder: ReturnType<typeof load>; storeUrl: string };

// Streamed, so the screen shows its loading state while Shopify answers. On
// the last confirmed plan, so a slow plan check never holds the stream; the
// shell reloads the screen, keeping its edits, if the check settles on another
// (app.tsx). `?count` answers the live line's Try again.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (new URL(request.url).searchParams.has("count"))
    return recount(admin, session.shop);
  const planAtLoad = await lastConfirmedPlan(session.shop);
  return {
    planAtLoad,
    fitFinder: load(admin, session.shop, planAtLoad.plan),
    storeUrl: `https://${session.shop}`,
  };
};

// The screen sends the fit finder section whole, with the primary language's
// "When no size fits", and the questions, their words, ease and stretch of
// each chart it changed. Everything else stays as stored. A part already holding what was sent (a
// retry after a partial save) is skipped, so a retry never reads as stale.
// A failed save answers with the parts that hold what was sent, written now or
// before, so the screen names what saved (§15).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = await request.json().catch(() => null);
  let wrote = false;
  const saved = { settings: false, charts: [] as string[] };
  const failed = (err: Error) => {
    log(session.shop, err);
    return data({ ...refusal("shopify"), saved }, { status: 502 });
  };
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
    const same = JSON.stringify(input) === JSON.stringify(s);
    saved.settings = same;
    // Every chart is checked before anything is written.
    const writes: (() => Promise<unknown>)[] = [];
    const sent = Array.isArray(body?.charts) ? body.charts.slice(0, 200) : [];
    const seen = new Set();
    for (const one of sent.map(Object)) {
      const { id, updatedAt, ease, stretch, questions, words } = one;
      if (seen.has(id)) continue;
      seen.add(id);
      const { chart, updatedAt: now } = await getChart(admin, id);
      if (!chart) throw new ChartConflictError("The chart doesn't read");
      const c = chart.content;
      const fit = fitOf(c);
      // Only the fit's own words come from the browser, as an object.
      if (
        words !== undefined &&
        (typeof words !== "object" || !words || Array.isArray(words))
      )
        throw new ChartValidationError({ "content.words": "Must be words" });
      const content = {
        ...c,
        fit: { ...fit, questions: questions ?? fit.questions, ease, stretch },
        words: words
          ? { ...fitWords(c.words, false), ...fitWords(words) }
          : c.words,
      };
      const key = (e: object) => JSON.stringify(Object.entries(e).sort());
      const sig = ({ fit: f, words: w }: typeof c) =>
        JSON.stringify([
          f?.questions,
          f?.stretch,
          key(f?.ease ?? {}),
          key(fitWords(w)),
        ]);
      if (c.fit && sig(content) === sig(c)) {
        saved.charts.push(id);
        continue;
      }
      // The chart's own conflict check (§5), here and again at its write.
      // Before validating, so a chart changed elsewhere asks for a reload.
      if (now !== updatedAt)
        throw new ChartConflictError("This chart changed since you opened it");
      const next = validateChart({ ...chart, content });
      writes.push(async () => {
        await updateChart(admin, id, next, updatedAt);
        saved.charts.push(id);
      });
    }
    const digest = typeof body?.digest === "string" ? body.digest : null;
    if (!same) {
      await saveSettings(admin, { ...loaded, digest }, input);
      saved.settings = wrote = true;
    }
    for (const write of writes) {
      await write();
      wrote = true;
    }
    return { ok: true as const };
  } catch (err) {
    // After a write landed, any failure is a partial save: Try saving again
    // finishes it, skipping what landed.
    if (wrote && err instanceof Error) return failed(err);
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
    return failed(err);
  }
};

// The FitFinder board's states: loading, couldn't load, no charts yet, set up.
export default function FitFinder() {
  const { fitFinder, storeUrl } = useLoaderData() as Screen;
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

// The form, with the shopper preview beside it when there is one.
const Page = (props: {
  banners?: ReactNode;
  action?: ReactNode;
  plan?: ReactNode;
  side?: ReactNode;
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
      {props.plan}
      <div className="split">
        <div className="form">{props.body}</div>
        {props.side}
      </div>
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
  saved?: Parts;
};
// The parts of a save: the settings, and each chart's fit by id.
type Parts = { settings: boolean; charts: string[] };
type Draft = {
  fitFinder: Settings["fitFinder"];
  noFit: string;
  // By chart id; `words` holds only the questions' words.
  fits: Record<
    string,
    {
      ease: string;
      stretch: Fit["stretch"];
      questions: Question[];
      words: Record<string, string>;
    }
  >;
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
// The half-saved banner's words for some parts, as the canvas puts them.
const LIST = new Intl.ListFormat("en", { type: "conjunction" });
const partWords = (parts: string[], charts: FitChart[]) => {
  const names = charts.filter((c) => parts.includes(c.id)).map((c) => c.name);
  return [
    parts.includes("settings") && "your fit finder settings",
    names.length > 0 && `the ease and stretch for ${LIST.format(names)}`,
  ]
    .filter(Boolean)
    .join(", and ");
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
        {
          ease: formatEase(c),
          stretch: c.fit.stretch,
          questions: c.fit.questions,
          words: fitWords(c.words),
        },
      ]),
    ),
  }));
  const [chartId, setChartId] = useState(
    (loaded.charts.find((c) => c.fit.questions.length) ?? loaded.charts[0])?.id,
  );
  const picked = loaded.charts.find((c) => c.id === chartId);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState(initial);
  const [local, setLocal] = useState<Answer | null>(null);
  const [dismissed, setDismissed] = useState<Answer>();
  // The parts the last save sent ("settings" or a chart id) with what was
  // sent, and those an earlier try saved, so a retry that fails sooner still
  // counts them.
  const [sent, setSent] = useState<Record<string, string>>({});
  const [landed, setLanded] = useState<Record<string, string>>({});
  const saving = fetcher.state !== "idle";
  const answer = saving ? undefined : fetcher.data;
  const notice = local ?? (answer === dismissed ? undefined : answer);
  const errors = notice?.fieldErrors ?? {};
  const marked = Object.keys(errors);
  const code = notice?.error?.code;
  const held = notice?.saved;
  const holds = (k: string) =>
    (held && (k === "settings" ? held.settings : held.charts.includes(k))) ||
    landed[k] === sent[k];
  const done = Object.keys(sent).filter(holds);
  const left = Object.keys(sent).filter((k) => !holds(k));

  const save = () => {
    const fieldErrors: FieldErrors = {};
    const charts = [];
    for (const c of loaded.charts) {
      const own = draft.fits[c.id];
      const was = initial.fits[c.id];
      if (JSON.stringify(own) === JSON.stringify(was)) continue;
      const text = own.ease;
      const ease = text === was.ease ? c.fit.ease : parseEase(c, text);
      if (!ease) {
        fieldErrors.ease = "Missing";
        setChartId(c.id);
        break;
      }
      charts.push({ ...own, id: c.id, updatedAt: c.updatedAt, ease });
    }
    if (!draft.noFit.trim()) fieldErrors.noFit = "Missing";
    if (Object.keys(fieldErrors).length) return setLocal({ fieldErrors });
    setLocal(null);
    const edits = { fitFinder: draft.fitFinder, noFit: draft.noFit };
    const was = { fitFinder: initial.fitFinder, noFit: initial.noFit };
    const key = JSON.stringify;
    const parts = Object.fromEntries(charts.map((c) => [c.id, key(c)]));
    if (key(edits) !== key(was)) parts.settings = key(edits);
    setLanded((l) => ({
      ...l,
      ...Object.fromEntries(done.map((k) => [k, sent[k]])),
    }));
    setSent(parts);
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
  const own = picked && draft.fits[picked.id];
  // The picked chart with the screen's unsaved questions and their words.
  const chart = picked &&
    own && {
      ...picked,
      fit: { ...picked.fit, questions: own.questions },
      words: { ...fitWords(picked.words, false), ...own.words },
    };
  const n = own?.questions.length ?? 0;
  // The live line's Try again counts once more, keeping the screen.
  const counter = useFetcher<Recount>();
  const counts = counter.data ? counter.data.counts : loaded.counts;
  const count = chart && counts !== "error" ? counts?.[chart.id] : undefined;
  const countFailed = counts === "error" && !!picked?.fit.questions.length;
  const putFit = (patch: Partial<Draft["fits"][string]>) =>
    setDraft((d) => ({
      ...d,
      fits: { ...d.fits, [chart!.id]: { ...d.fits[chart!.id], ...patch } },
    }));
  // Puts a question at i (or removes the one there) with its words, dropping
  // the old question's.
  const putQuestion = (i: number, q?: Question, words = {}) => {
    const old = own!.questions[i];
    const questions = [...own!.questions];
    questions.splice(i, old ? 1 : 0, ...(q ? [q] : []));
    // Keys are fit.<question> and fit.<question>.<answer>.
    const kept = Object.entries(own!.words).filter(
      ([k]) => k.split(".")[1] !== old?.id,
    );
    putFit({ questions, words: { ...Object.fromEntries(kept), ...words } });
    setEditing(null);
  };
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
      ) : code && held && done.length > 0 && left.length > 0 ? (
        <Banner copy={["Some of your changes weren't saved"]}>
          <s-paragraph>
            <strong>Saved:</strong> {partWords(done, loaded.charts)}.
          </s-paragraph>
          <s-paragraph>
            <strong>Not saved:</strong> {partWords(left, loaded.charts)}. Your
            edits are still here.
          </s-paragraph>
          {button("Try saving again", save)}
        </Banner>
      ) : (
        code && (
          <Banner copy={COPY.shopify}>
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
        plan={
          loaded.plan !== "pro" ? (
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
          ) : countFailed ? (
            <div role="alert" className="live">
              <span className="badge ok">Live</span>
              <span>
                Find my size shows on the products with {chart!.name}.{" "}
                <span className="err">
                  Fitted couldn&apos;t count them just now.
                </span>
              </span>
              <s-button
                onClick={() => counter.load("/app/fit-finder?count")}
                loading={counter.state !== "idle" || undefined}
              >
                Try again
              </s-button>
            </div>
          ) : count?.count === 0 ? (
            <div role="status" className="live">
              <span className="badge warn">Not showing</span>
              <span>
                No products show {chart!.name} yet, so no shopper sees these
                questions.
              </span>
              <s-button href="/app/rules">Open Display rules</s-button>
            </div>
          ) : (
            chart &&
            count && (
              <div role="status" className="live">
                <span className="badge ok">Live</span>
                <span>
                  Find my size shows on the{" "}
                  {count.count.toLocaleString("en-US")}
                  {count.atLeast ? "+" : ""}{" "}
                  {count.count === 1 && !count.atLeast ? "product" : "products"}{" "}
                  with {chart.name}. Changes go live when you save.
                </span>
              </div>
            )
          )
        }
        side={
          chart &&
          own &&
          n > 0 && (
            <ShopperPreview
              chart={chart}
              own={own}
              saved={initial.fits[chart.id].ease}
              noFit={draft.noFit}
            />
          )
        }
        body={
          <>
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
                {own && n > 0 && (
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
                <ol className="qs" hidden={!n}>
                  {chart.fit.questions.map((q, i) => {
                    const d = describe(chart, q);
                    return (
                      <li key={q.id}>
                        <span className="num" aria-hidden="true">
                          {i + 1}
                        </span>
                        <span className="grow">
                          <strong>{d.words}</strong>
                          <span className="help">{d.kind}</span>
                        </span>
                        <s-button
                          accessibilityLabel={`Edit question ${i + 1}`}
                          onClick={() => setEditing(i)}
                        >
                          Edit
                        </s-button>
                      </li>
                    );
                  })}
                </ol>
                {/* A fit finder asks 1 to 6 questions (§10). */}
                <div className="row start">
                  <s-button
                    disabled={n >= 6 || undefined}
                    onClick={() => setEditing(n)}
                  >
                    Add question
                  </s-button>
                  {n >= 6 && (
                    <span className="help">
                      A fit finder asks up to 6 questions.
                    </span>
                  )}
                </div>
                {editing !== null && (
                  <QuestionEditor
                    chart={chart}
                    index={editing}
                    type={f.type}
                    onDone={(q, words) => putQuestion(editing, q, words)}
                    onRemove={() => putQuestion(editing)}
                    onClose={() => setEditing(null)}
                  />
                )}
              </section>
            )}

            {chart && n > 0 && (
              <section className="card" aria-labelledby="h-logic">
                <h2 id="h-logic">How Fitted picks a size</h2>
                <ol className="list">
                  {howItPicks(chart).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ol>
                <p className="help">
                  Shoppers always see why a size was picked, so they can trust
                  it.
                </p>
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

// "What shoppers see": findSize on the picked chart for sample answers, with
// the screen's unsaved stretch, and its unsaved ease while that reads. A
// picture of the storefront's last step, so nothing in it is a control.
function ShopperPreview(props: {
  chart: FitChart;
  own: Draft["fits"][string];
  saved: string;
  noFit: string;
}) {
  const { chart: c, own } = props;
  const ease =
    own.ease === props.saved
      ? c.fit.ease
      : (parseEase(c, own.ease) ?? c.fit.ease);
  const answers = sampleAnswers(c);
  const fit = { ...c.fit, ease, stretch: own.stretch };
  const result = findSize({ unit: c.unit, tables: [c.table], fit }, answers);
  const step = lastStep(c, answers);
  const why = reasonText({ ...c, fit }, result);
  const n = c.fit.questions.length;
  return (
    <aside className="card shopper" aria-label="Shopper preview">
      <div className="row">
        <h2>What shoppers see</h2>
        <span className="badge">Preview</span>
      </div>
      <div className="step">
        <div className="count">
          <span>
            Question {n} of {n}
          </span>
          <span>Find my size</span>
        </div>
        <span className="bar" />
        <strong className="words">{step.words}</strong>
        {step.options.map((o, i) => (
          <span key={i} className={o.on ? "opt on" : "opt"}>
            {o.label}
          </span>
        ))}
        <div className="row">
          <span className="back">Back</span>
          <span className="cart">See my size</span>
        </div>
      </div>
      <div className="yours">
        {result.row === null ? (
          <>
            <span>{props.noFit}</span>
            {why && <span>{why}</span>}
          </>
        ) : (
          <>
            <strong>Your size</strong>
            <span className="size">{size(c, result.row)}</span>
            {why && <span>{why}</span>}
            <span className="cart">Select {size(c, result.row)}</span>
          </>
        )}
      </div>
    </aside>
  );
}
