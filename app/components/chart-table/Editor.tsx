// The Editor board (Fitted canvas): name, template, status, the size table,
// units and the note, saved through App Bridge's save bar. Later steps add the
// table tools, tabs, live preview and version history around this.
import { type ReactNode, useRef, useState } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";
import { SaveBar } from "@shopify/app-bridge-react";
import type { FieldErrors, Template } from "../../models/chart.server";
import { ChartTable } from "./ChartTable";
import * as model from "./model";
import "./editor.css";

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
  /** The chart saved, but its version history didn't record it (§5). */
  historyMissed?: true;
};

export function Editor(props: {
  /** The stored chart; the route remounts the editor when it reloads. */
  initial: model.Draft;
  updatedAt?: string;
  /** Set for a new chart: the handle its create lands on. */
  handle?: string;
  /** Set when the stored chart fails the checks: the server's findings. */
  invalid?: FieldErrors;
  /** The create saved the chart but not its first version. */
  historyMissed?: boolean;
}) {
  const { handle, invalid } = props;
  const fetcher = useFetcher<Answer>();
  const revalidator = useRevalidator();
  const [draft, setDraft] = useState(props.initial);
  // The editor's own check, or the action's answer until it's dismissed. A
  // stored chart that fails the checks opens with them, in the editor's words
  // where it has them.
  const [opened] = useState<Answer | null>(() => {
    if (!invalid) return null;
    const own = model.toInput(props.initial);
    const mine = "fieldErrors" in own ? own.fieldErrors : {};
    return { stored: true, fieldErrors: { ...invalid, ...mine } };
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

  return (
    <s-page>
      <SaveBar
        id="chart-save-bar"
        open={saving || JSON.stringify(draft) !== JSON.stringify(initial)}
      >
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
        {(answer?.historyMissed || (props.historyMissed && !answer?.ok)) && (
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
                        document.getElementById(p.id!)?.focus();
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
          {!handle && (
            <details className="more">
              <summary className="btn2">More actions</summary>
              <div className="menu" role="menu">
                <Link to="history" role="menuitem">
                  Version history
                </Link>
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
              onChange={setDraft}
              onRemove={(sel) => {
                setDraft(model.remove(draft, sel));
                // Cell findings name sizes by position, so they move up too.
                if (!notice?.fieldErrors) return;
                const left = model.removeErrors(draft, sel, notice.fieldErrors);
                // With none left, the banner goes, as after a fix and save.
                if (Object.keys(left).length)
                  setLocal({ ...notice, fieldErrors: left });
                else dismiss();
              }}
            />
          ) : (
            <h2 className="blank">A blank chart, ready for sizes</h2>
          )}
          <p className="help">
            Type in inches or centimeters. Fitted converts the other unit for
            shoppers automatically.
          </p>
          <label>
            Note under the table
            <textarea
              className="field"
              rows={2}
              value={draft.content.words[`${t.id}.note`] ?? ""}
              onChange={(e) =>
                setDraft(model.setWord(draft, `${t.id}.note`, e.target.value))
              }
            />
          </label>
        </section>
      </div>
    </s-page>
  );
}
