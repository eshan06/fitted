// The Editor board (Fitted canvas): name, template, status, the size table,
// units and the note, saved through App Bridge's save bar. Later steps add the
// table tools, tabs, live preview and version history around this.
import { useRef, useState } from "react";
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
  error?: { code: string; message: string };
  updatedAt?: string;
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

export function Editor(props: {
  /** The stored chart; the route remounts the editor when it reloads. */
  initial: model.Draft;
  updatedAt?: string;
  /** Set for a new chart: the handle its create lands on. */
  handle?: string;
}) {
  const { handle } = props;
  const fetcher = useFetcher<Answer>();
  const revalidator = useRevalidator();
  const [draft, setDraft] = useState(props.initial);
  // The editor's own check, or the action's answer until it's dismissed.
  const [local, setLocal] = useState<Answer | null>(null);
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

  const save = () => {
    const r = model.toInput(draft);
    if ("fieldErrors" in r) return setLocal(r);
    setLocal(null);
    sent.current = draft;
    const body = handle
      ? { handle, chart: r.input }
      : { chart: r.input, status: draft.status, updatedAt: base.updatedAt };
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
  const still = `Edits saved, but the chart is still ${initial.status === "ACTIVE" ? "Published" : "a Draft"}`;
  const headings: Record<string, string> = {
    conflict: "Chart changed since you opened it",
    plan_limit: `${initial.name} wasn't published`,
    status: still,
    product_access: still,
  };
  const lines =
    err?.code === "conflict"
      ? [
          "Your edits weren't saved, so nothing was overwritten.",
          "Reload latest shows the newest version and discards your edits.",
        ]
      : err?.code === "shopify"
        ? [
            "Shopify didn't respond in time, so the chart on your store hasn't changed. Your edits are still here.",
          ]
        : [err?.message];
  const action = (label: string, onClick: () => void) => (
    <s-button slot="secondary-actions" onClick={onClick}>
      {label}
    </s-button>
  );

  return (
    <s-page>
      <SaveBar
        id="chart-save-bar"
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
      <div className="editor">
        {notice?.fieldErrors && (
          <s-banner
            tone="critical"
            heading={`Fix ${listed.length} ${listed.every((p) => p.short) ? "cell" : "field"}${listed.length === 1 ? "" : "s"} to save`}
          >
            <s-paragraph>
              Nothing was saved, so your store hasn&apos;t changed.
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
          <s-banner
            tone="critical"
            heading={headings[err.code] ?? "Your changes weren't saved"}
          >
            {lines.map((l) => (
              <s-paragraph key={l}>{l}</s-paragraph>
            ))}
            {err.code === "conflict" ? (
              <>
                {action("Reload latest", () => revalidator.revalidate())}
                {action("Cancel", dismiss)}
              </>
            ) : (
              err.code !== "plan_limit" && action("Try saving again", save)
            )}
          </s-banner>
        )}
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
                {Object.entries(TEMPLATES).map(([v, label]) => (
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
