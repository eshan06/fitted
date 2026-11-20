// The Editor board (Fitted canvas): name, template, status, and the tabs: the
// size table with its tools, units and note, How to measure's steps, and Fit
// tips, saved through App Bridge's save bar. Later steps add the drawing, the
// Media tab, a second table and the live preview.
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Link,
  useBlocker,
  useFetcher,
  useNavigate,
  useRevalidator,
} from "react-router";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import type { FieldErrors, Template } from "../../models/chart.server";
import { ChartTable } from "./ChartTable";
import { PasteDialog } from "./PasteDialog";
import { MeasureTab } from "./MeasureTab";
import * as model from "./model";
import "./editor.css";

const SAVE_BAR = "chart-save-bar";
const TABS = {
  table: "Size table",
  measure: "How to measure",
  tips: "Fit tips",
};
type Tab = keyof typeof TABS;
// The tab that holds a field the banner links to (model.problems).
const tabOf = (id: string): Tab =>
  id === "tips" ? "tips" : id.startsWith("m-") ? "measure" : "table";

/** What the action answers (ARCHITECTURE §15). */
type Answer = {
  ok?: true;
  fieldErrors?: FieldErrors;
  /** The fieldErrors are the stored chart's, found on load. */
  stored?: true;
  error?: {
    code: string;
    message: string;
    // plan_limit's numbers and its See plans link
    limit?: number;
    published?: number;
    checkFailed?: boolean;
    plansUrl?: string;
  };
  updatedAt?: string;
  /** The edits saved, the status didn't, and history missed the save. */
  historyMissed?: true;
  /** A new chart's id, once it's created. */
  created?: string;
};

export function Editor(props: {
  /** The stored chart; the route remounts the editor when it reloads. */
  initial: model.Draft;
  updatedAt?: string;
  /** Set for a new chart: the handle its create lands on. */
  handle?: string;
  /** Set when the stored chart fails the checks: the server's findings. */
  invalid?: FieldErrors;
  /**
   * The last save landed, but its version history didn't (§5). Kept by the
   * route: a save that lands reloads the chart, which remounts the editor.
   */
  historyMissed?: boolean;
}) {
  const { handle, invalid } = props;
  const fetcher = useFetcher<Answer>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [draft, setDraft] = useState(props.initial);
  const [pasting, setPasting] = useState(false);
  const [tab, setTab] = useState<Tab>("table");
  // The editor's own check, or the action's answer until it's dismissed. A
  // stored chart that fails the checks opens with them, in the editor's words
  // where it has them. A number in a column that isn't a measurement isn't
  // one to fix: the save leaves it out, and the drop warning names it unless
  // the cell's words already hold it.
  const [opened] = useState<Answer | null>(() => {
    if (!invalid) return null;
    const own = model.toInput(props.initial);
    const mine = "fieldErrors" in own ? own.fieldErrors : {};
    const t0 = props.initial.content.tables[0];
    const rest = Object.entries(invalid).filter(([k]) => {
      const col = /^content\.tables\.0\.rows\.\d+\.cells\.(.+)$/.exec(k)?.[1];
      return !col || t0.columns.find((c) => c.id === col)?.kind === "measure";
    });
    const all = { ...Object.fromEntries(rest), ...mine };
    return Object.keys(all).length ? { stored: true, fieldErrors: all } : null;
  });
  const [local, setLocal] = useState(opened);
  const [dismissed, setDismissed] = useState<Answer>();
  // What's stored. A save that writes the edits but not the status hands back
  // the new updatedAt without a reload: the sent edits are stored from then on.
  const [base, setBase] = useState({
    initial: props.initial,
    updatedAt: props.updatedAt,
  });
  const { initial } = base;
  const sent = useRef(draft);
  const saving = fetcher.state !== "idle";
  const answer = saving ? undefined : fetcher.data;
  if (answer?.updatedAt && answer.updatedAt !== base.updatedAt)
    setBase({
      initial: { ...sent.current, status: initial.status },
      updatedAt: answer.updatedAt,
    });
  const notice = local ?? (answer === dismissed ? undefined : answer);
  const errors = notice?.fieldErrors ?? {};
  const listed = model.problems(draft, errors);
  const t = draft.content.tables[0];
  const set = (patch: Partial<model.Draft>) => setDraft({ ...draft, ...patch });
  const created = answer?.created;
  const dirty =
    !created && (saving || JSON.stringify(draft) !== JSON.stringify(initial));
  // The save bar holds the admin's links but not the app's own (App Bridge's
  // Save Bar API), so a link out of the editor asks the admin first: on the
  // dev store it shakes the save bar and stays until Save or Discard. A save's
  // redirect isn't a link, so it isn't held.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let live = true;
    // Staying never settles it; the next click asks again.
    shopify.saveBar
      .leaveConfirmation()
      .then(() => shopify.saveBar.hide(SAVE_BAR))
      .then(() => live && blocker.proceed())
      .catch(() => {
        if (!live) return;
        blocker.reset();
        shopify.toast.show(
          "Couldn't leave this page. Save or discard your edits, then try again.",
          { isError: true },
        );
      });
    return () => {
      live = false;
    };
  }, [blocker, shopify]);

  // While the save bar shows, the admin's address bar ignores the app's route
  // (App Bridge's Navigation API), so a new chart's address waits for it to
  // hide. Replaced, so Back skips the blank chart.
  const missed = answer?.historyMissed;
  useEffect(() => {
    if (!created) return;
    let live = true;
    const open = () =>
      live &&
      navigate(`/app/charts/${created}${missed ? "?history=missed" : ""}`, {
        replace: true,
      });
    // A failed hide still opens the chart; only the address may lag.
    shopify.saveBar.hide(SAVE_BAR).then(open, open);
    return () => {
      live = false;
    };
  }, [created, missed, navigate, shopify]);

  const save = (d = draft) => {
    setDraft(d);
    const r = model.toInput(d);
    if ("fieldErrors" in r) return setLocal(r);
    setLocal(null);
    sent.current = model.toDraft(r.input, d.status);
    const body = handle
      ? { handle, chart: r.input }
      : { chart: r.input, status: d.status, updatedAt: base.updatedAt };
    fetcher.submit(body as never, {
      method: "post",
      encType: "application/json",
    });
  };
  const dismiss = () => {
    setLocal(null);
    setDismissed(answer);
  };
  // A filled table comes in with the cells Fitted can't read marked, as after
  // a save (the Editor board's "Fix the marked fields").
  const fill = (p: model.Pasted) => {
    const next = model.replaceTable(draft, p);
    setDraft(next);
    setPasting(false);
    dismiss();
    const r = model.toInput(next);
    const marked =
      "fieldErrors" in r
        ? Object.fromEntries(
            Object.entries(r.fieldErrors).filter(([k]) => k !== "name"),
          )
        : {};
    if (Object.keys(marked).length) setLocal({ fieldErrors: marked });
    const t0 = next.content.tables[0];
    setTimeout(() =>
      document
        .getElementById(`cell-${t0.rows[0].id}-${t0.columns[0].id}`)
        ?.focus(),
    );
  };
  const err = notice?.error;
  const action = (label: string, onClick: () => void) => (
    <s-button slot="secondary-actions" onClick={onClick}>
      {label}
    </s-button>
  );
  // The Editor board's banner for each answer: heading, lines, actions.
  const publishing = draft.status === "ACTIVE";
  const still = `Edits saved, but the chart is still ${initial.status === "ACTIVE" ? "Published" : "a Draft"}`;
  const tryStatus = action(
    `Try ${publishing ? "publishing" : "unpublishing"} again`,
    () => save(),
  );
  const banners: Record<string, [string, string[], ReactNode]> = {
    conflict: [
      "Chart changed since you opened it",
      [
        "Your edits weren't saved, so nothing was overwritten.",
        "Reload latest shows the newest version and discards your edits.",
      ],
      <>
        {action("Reload latest", () => revalidator.revalidate())}
        {action("Cancel", dismiss)}
      </>,
    ],
    plan_limit: [
      `${initial.name} wasn't published`,
      [
        ...(err?.checkFailed
          ? ["Couldn't check your plan, so Fitted counts it as Free."]
          : []),
        `The Free plan allows ${err?.limit} published charts and you have ${err?.published}, so nothing was saved.`,
        "Save it as a Draft, or see plans to publish more.",
      ],
      <>
        {/* A new tab: the admin's save bar holds this one while there are unsaved edits. */}
        {err?.plansUrl && (
          <s-button
            slot="secondary-actions"
            href={err.plansUrl}
            target="_blank"
          >
            See plans
          </s-button>
        )}
        {action("Save as Draft", () => save({ ...draft, status: "DRAFT" }))}
      </>,
    ],
    status: [
      still,
      [
        publishing
          ? `Shopify didn't publish ${initial.name}, so shoppers can't see it yet.`
          : `Shopify didn't unpublish ${initial.name}, so shoppers can still see it.`,
      ],
      tryStatus,
    ],
    // The Rules board's "No access to products" wording.
    product_access: [
      still,
      [
        `You need Products access to ${publishing ? "publish" : "unpublish"} charts, since that also updates your products.`,
        "Ask the store owner to add Products access to your account in Settings › Users.",
      ],
      tryStatus,
    ],
  };
  const [heading, lines, actions] = (err && banners[err.code]) ?? [
    "Your changes weren't saved",
    [
      "Shopify didn't respond in time, so the chart on your store hasn't changed. Your edits are still here.",
    ],
    action("Try saving again", () => save()),
  ];
  const n = listed.length;
  // Once a save is stored, the numbers are gone, even when only the status
  // failed and the editor stays open.
  const drops = base.updatedAt === props.updatedAt ? model.dropped(draft) : [];

  return (
    <s-page>
      <SaveBar id={SAVE_BAR} open={dirty}>
        <button
          variant="primary"
          onClick={() => save()}
          loading={saving ? "" : undefined}
        >
          Save
        </button>
        <button
          disabled={saving}
          onClick={() => {
            setDraft(initial);
            dismiss();
            // The opening findings hold only until a save stores new content.
            setLocal(base.updatedAt === props.updatedAt ? opened : null);
          }}
        >
          Discard
        </button>
      </SaveBar>
      <div className="editor">
        {((props.historyMissed && !answer) || answer?.historyMissed) && (
          <s-banner
            tone="warning"
            heading="Saved, but version history missed it"
          >
            <s-paragraph>
              The chart on your store is up to date. This save won&apos;t show
              in version history.
            </s-paragraph>
          </s-banner>
        )}
        {notice?.fieldErrors && (
          <s-banner
            tone="critical"
            heading={
              notice.stored
                ? `Fix ${n} ${n === 1 ? "value" : "values"} to save this chart`
                : `Fix ${n} ${listed.every((p) => p.short) ? "cell" : "field"}${n === 1 ? "" : "s"} to save`
            }
          >
            <s-paragraph>
              {notice.stored
                ? "They were changed outside Fitted. Nothing on your store has changed."
                : "Nothing was saved, so your store hasn't changed."}
            </s-paragraph>
            <ul className="list">
              {listed.map((p, i) => (
                <li key={p.id ?? i}>
                  {p.id ? (
                    <a
                      href={`#${p.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        setTab(tabOf(p.id!));
                        setTimeout(() =>
                          document.getElementById(p.id!)?.focus(),
                        );
                      }}
                    >
                      {p.where}
                    </a>
                  ) : (
                    p.where
                  )}
                  {p.short ? ` ${p.short}` : `${p.where && ": "}${p.long}`}
                </li>
              ))}
            </ul>
          </s-banner>
        )}
        {err && (
          <s-banner tone="critical" heading={heading}>
            {lines.map((l) => (
              <s-paragraph key={l}>{l}</s-paragraph>
            ))}
            {actions}
          </s-banner>
        )}
        {drops.map((x) => (
          <s-banner key={x.col} tone="warning" heading={x.heading}>
            <s-paragraph>{x.text}</s-paragraph>
            <s-paragraph>
              <strong>{x.fix}</strong>
            </s-paragraph>
          </s-banner>
        ))}
        <div className="row">
          <div>
            <Link to="/app/charts">Size charts</Link>
            <div className="row">
              <h1>{handle ? "New chart" : initial.name}</h1>
              {!handle && (
                <select
                  className="field auto"
                  aria-label="Chart status"
                  value={draft.status}
                  onChange={(e) =>
                    set({ status: e.target.value as model.Draft["status"] })
                  }
                >
                  <option value="ACTIVE">Published</option>
                  <option value="DRAFT">Draft</option>
                </select>
              )}
            </div>
          </div>
          {/* Copy link and Duplicate join it with #127. */}
          {!handle && (
            <details className="more">
              <summary className="btn2">More actions</summary>
              <div className="menu">
                <Link to="history">Version history</Link>
              </div>
            </details>
          )}
        </div>
        <section className="card" aria-label="Chart content">
          <div className="row">
            <label className="grow">
              Chart name
              <input
                id="name"
                className={errors.name ? "field bad" : "field"}
                placeholder="For example, Women's tops"
                aria-invalid={errors.name ? true : undefined}
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <label className="grow">
              Template
              <select
                className="field"
                value={draft.template}
                onChange={(e) => set({ template: e.target.value as Template })}
              >
                {Object.entries(model.TEMPLATES).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="tabs">
            {Object.entries(TABS).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="tab"
                aria-pressed={tab === id}
                onClick={() => setTab(id as Tab)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "measure" && (
            <MeasureTab draft={draft} onChange={setDraft} />
          )}
          {tab === "tips" && (
            <div>
              <label>
                Fit tips
                <textarea
                  id="tips"
                  className="field"
                  rows={5}
                  maxLength={2000}
                  placeholder="For example, Runs small through the shoulders. Size up if you're between sizes."
                  value={draft.content.words.tips ?? ""}
                  onChange={(e) =>
                    setDraft(model.setWord(draft, "tips", e.target.value))
                  }
                />
              </label>
              <div className="row">
                <span className="help">
                  Shoppers see these under the size table.
                </span>
                <span className="help">
                  {(draft.content.words.tips ?? "").length.toLocaleString(
                    "en-US",
                  )}{" "}
                  of 2,000 characters
                </span>
              </div>
            </div>
          )}
          {tab === "table" && (
            <>
              <div className="row">
                <div role="group" aria-label="Units" className="segs">
                  {(["in", "cm"] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      aria-pressed={draft.content.unit === u}
                      onClick={() => setDraft(model.setUnit(draft, u))}
                    >
                      {u}
                    </button>
                  ))}
                </div>
                <s-stack direction="inline" gap="small-200">
                  <s-button
                    disabled={t.rows.length >= model.MAX_ROWS}
                    onClick={() => setDraft(model.addSize(draft))}
                  >
                    Add size
                  </s-button>
                  <s-button
                    disabled={t.columns.length >= model.MAX_COLUMNS}
                    onClick={() => setDraft(model.addMeasurement(draft))}
                  >
                    Add measurement
                  </s-button>
                </s-stack>
              </div>
              {t.rows.length ? (
                <ChartTable
                  draft={draft}
                  errors={errors}
                  problems={listed}
                  dropped={drops.flatMap((x) => x.cells)}
                  onChange={setDraft}
                  onPaste={() => setPasting(true)}
                  onRemove={(sel) => {
                    setDraft(model.remove(draft, sel));
                    // Cell findings name sizes by position, so they move up too.
                    if (!notice?.fieldErrors) return;
                    const left = model.removeErrors(
                      draft,
                      sel,
                      notice.fieldErrors,
                    );
                    // With none left, the banner goes, as after a fix and save.
                    if (Object.keys(left).length)
                      setLocal({ ...notice, fieldErrors: left });
                    else dismiss();
                  }}
                />
              ) : (
                <div className="blank">
                  <svg
                    width="56"
                    height="56"
                    viewBox="0 0 48 48"
                    fill="none"
                    stroke="#2448A8"
                    strokeLinecap="square"
                    aria-hidden="true"
                  >
                    <path
                      d="M10 40V10h30"
                      strokeWidth="3"
                      strokeDasharray="4 3"
                    />
                    <path d="M17 40V17h23" strokeWidth="6" />
                    <path d="M24 40V24h16" strokeWidth="3" />
                  </svg>
                  <h2>A blank chart, ready for sizes</h2>
                  <p className="help">
                    Paste a whole table from a spreadsheet or supplier sheet and
                    Fitted fills in the sizes and measurements. Or pick a
                    template above.
                  </p>
                  <s-button variant="primary" onClick={() => setPasting(true)}>
                    Paste whole chart
                  </s-button>
                </div>
              )}
              {pasting && (
                <PasteDialog onClose={() => setPasting(false)} onFill={fill} />
              )}
              <p className="help">
                Type in inches or centimeters. Fitted converts the other unit
                for shoppers automatically.
              </p>
              <label>
                Note under the table
                <textarea
                  className="field"
                  rows={2}
                  value={draft.content.words[`${t.id}.note`] ?? ""}
                  onChange={(e) =>
                    setDraft(
                      model.setWord(draft, `${t.id}.note`, e.target.value),
                    )
                  }
                />
              </label>
            </>
          )}
        </section>
      </div>
    </s-page>
  );
}
