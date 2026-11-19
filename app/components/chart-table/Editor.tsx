// The Editor board (Fitted canvas): name, template, status, the size table,
// units and the note, saved through App Bridge's save bar. Later steps add the
// table tools, tabs, live preview and version history around this.
import { useState } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";
import { SaveBar } from "@shopify/app-bridge-react";
import type { FieldErrors, Template } from "../../models/chart.server";
import { ChartTable } from "./ChartTable";
import {
  type Draft,
  MAX_COLUMNS,
  MAX_ROWS,
  addMeasurement,
  addSize,
  problems,
  setUnit,
  setWord,
  toInput,
} from "./model";
import "./editor.css";

/** What the action answers (ARCHITECTURE §15). */
export type Answer = {
  ok?: true;
  fieldErrors?: FieldErrors;
  updatedAt?: string;
  error?: {
    code: string;
    message: string;
    limit?: number;
    published?: number;
    checkFailed?: boolean;
    plansUrl?: string;
  };
};

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

export function Editor({
  initial,
  updatedAt,
  handle,
}: {
  /** The stored chart; the route remounts the editor when it reloads. */
  initial: Draft;
  updatedAt?: string;
  /** Set for a new chart: the handle its create lands on. */
  handle?: string;
}) {
  const fetcher = useFetcher<Answer>();
  const revalidator = useRevalidator();
  const [draft, setDraft] = useState(initial);
  // The editor's own check, or the action's last answer until dismissed.
  const [local, setLocal] = useState<Answer | null>(null);
  const [dismissed, setDismissed] = useState<Answer>();
  // A save that fails after writing hands back the chart's new updatedAt.
  const [stamp, setStamp] = useState(updatedAt);
  const answer = fetcher.state === "idle" ? fetcher.data : undefined;
  if (answer?.updatedAt && answer.updatedAt !== stamp)
    setStamp(answer.updatedAt);
  const notice = local ?? (answer !== dismissed ? answer : undefined);
  const saving = fetcher.state !== "idle";
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const errors = notice?.fieldErrors ?? {};
  const listed = problems(draft, errors);
  const t = draft.content.tables[0];

  const save = (d = draft) => {
    setDraft(d);
    const r = toInput(d);
    if ("fieldErrors" in r) return setLocal(r);
    setLocal(null);
    const body = handle
      ? { handle, chart: r.input }
      : { chart: r.input, status: d.status, updatedAt: stamp };
    fetcher.submit(body as never, {
      method: "post",
      encType: "application/json",
    });
  };
  const dismiss = () => {
    setLocal(null);
    setDismissed(answer);
  };
  const button = (label: string, onClick: () => void) => (
    <s-button slot="secondary-actions" onClick={onClick}>
      {label}
    </s-button>
  );
  const banner = (heading: string, lines: string[], actions?: JSX.Element) => (
    <s-banner tone="critical" heading={heading}>
      {lines.map((l) => (
        <s-paragraph key={l}>{l}</s-paragraph>
      ))}
      {actions}
    </s-banner>
  );

  const err = notice?.error;
  const still = `Edits saved, but the chart is still ${initial.status === "ACTIVE" ? "Published" : "a Draft"}`;
  const publishing = draft.status === "ACTIVE";
  const tryStatus = button(
    `Try ${publishing ? "publishing" : "unpublishing"} again`,
    () => save(),
  );
  let shown: JSX.Element | null = null;
  if (notice?.fieldErrors) {
    const cells = listed.every((p) => p.short);
    shown = (
      <s-banner
        tone="critical"
        heading={`Fix ${listed.length} ${cells ? "cell" : "field"}${listed.length === 1 ? "" : "s"} to save`}
      >
        <s-paragraph>
          Nothing was saved, so your store hasn't changed.
        </s-paragraph>
        <ul className="list">
          {listed.map((p) => (
            <li key={p.id ?? p.long}>
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
              {p.short ? ` ${p.short}` : `${p.where ? ": " : ""}${p.long}`}
            </li>
          ))}
        </ul>
      </s-banner>
    );
  } else if (err?.code === "conflict")
    shown = banner(
      "Chart changed since you opened it",
      [
        "Your edits weren't saved, so nothing was overwritten.",
        "Reload latest shows the newest version and discards your edits.",
      ],
      <>
        {button("Reload latest", () => revalidator.revalidate())}
        {button("Cancel", dismiss)}
      </>,
    );
  else if (err?.code === "plan_limit")
    shown = banner(
      `${initial.name} wasn't published`,
      [
        ...(err.checkFailed
          ? ["Couldn't check your plan, so Fitted counts it as Free."]
          : []),
        `The Free plan allows ${err.limit} published charts and you have ${err.published}, so nothing was saved.`,
        "Save it as a Draft, or see plans to publish more.",
      ],
      <>
        <s-button slot="secondary-actions" href={err.plansUrl} target="_top">
          See plans
        </s-button>
        {button("Save as Draft", () => save({ ...draft, status: "DRAFT" }))}
      </>,
    );
  else if (err?.code === "status")
    shown = banner(
      still,
      [
        publishing
          ? `Shopify didn't publish ${initial.name}, so shoppers can't see it yet.`
          : `Shopify didn't unpublish ${initial.name}, so shoppers still see it.`,
      ],
      tryStatus,
    );
  else if (err?.code === "product_access")
    // The Rules board's "No access to products" wording.
    shown = banner(
      still,
      [
        `You need Products access to ${publishing ? "publish" : "unpublish"} charts, since that also updates your products.`,
        "Ask the store owner to add Products access to your account in Settings › Users.",
      ],
      tryStatus,
    );
  else if (err)
    shown = banner(
      "Your changes weren't saved",
      [
        err.code === "shopify"
          ? "Shopify didn't respond in time, so the chart on your store hasn't changed. Your edits are still here."
          : err.message,
      ],
      button("Try saving again", () => save()),
    );

  return (
    <s-page>
      <SaveBar id="chart-save-bar" open={dirty || saving}>
        <button
          variant="primary"
          onClick={() => save()}
          loading={saving ? "" : undefined}
        >
          Save
        </button>
        <button
          onClick={() => {
            setDraft(initial);
            dismiss();
          }}
          disabled={saving}
        >
          Discard
        </button>
      </SaveBar>
      <div className="editor">
        {!saving && shown}
        <div>
          <Link to="/app/charts">Size charts</Link>
          <div className="row start">
            <h1>{handle ? "New chart" : initial.name}</h1>
            {!handle && (
              <select
                className="field auto"
                aria-label="Chart status"
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
        <section className="card" aria-label="Chart content">
          <div className="row top">
            <div className="grow2">
              <label className="lbl" htmlFor="name">
                Chart name
              </label>
              <input
                id="name"
                className={errors.name ? "field bad" : "field"}
                placeholder="For example, Women's tops"
                aria-invalid={errors.name ? true : undefined}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>
            <div className="grow1">
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
            <div role="group" aria-label="Units" className="segs">
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
            <ChartTable
              draft={draft}
              errors={errors}
              problems={listed}
              onChange={setDraft}
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
                <path d="M10 40V10h30" strokeWidth="3" strokeDasharray="4 3" />
                <path d="M17 40V17h23" strokeWidth="6" />
                <path d="M24 40V24h16" strokeWidth="3" />
              </svg>
              <h2>A blank chart, ready for sizes</h2>
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
              className="field note"
              rows={2}
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
