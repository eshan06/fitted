// The FitFinder board's question editor (Fitted canvas): Edit and Add question
// open it over the screen. Done or Add question hands the question and its
// words back to the screen's edits; the save bar's Save writes them (§10).
import { useState } from "react";
import type { Question } from "../../lib/fit-finder";
import type { Settings } from "../../models/settings.server";
import type { FitChart } from "./chart-fit";

type Kind = Question["kind"];
const KINDS: Record<Kind, [string, string]> = {
  measure: [
    "Measurement",
    "A number from the shopper, matched to a chart column",
  ],
  usual_size: [
    "Usual size",
    "The size they usually wear, from your chart's sizes",
  ],
  fit: ["Fit preference", "Snug, Regular or Relaxed"],
  choice: [
    "Choice",
    "Your own answers. Each one keeps only the sizes you pick.",
  ],
};
// The kinds each fit finder type offers (§7). ponytail: Choice's answers
// editor is its own step, so until then Choice shows only on a question that
// already is one, and keeps its answers as stored.
const OFFERED: Record<Settings["fitFinder"]["type"], Kind[]> = {
  basic: ["measure", "fit"],
  advanced: ["measure", "usual_size", "fit"],
  custom: ["measure", "usual_size", "fit"],
};
// A new id in §5's pattern, unused in the fit table and its questions. The
// chart's validator refuses a repeat in its other tables.
const newId = (c: FitChart) => {
  const t = c.table;
  const used = [t, ...t.columns, ...t.rows, ...c.fit.questions].map(
    (x) => x.id,
  );
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10);
    if (id && !used.includes(id)) return id;
  }
};

export function QuestionEditor(props: {
  chart: FitChart; // with the screen's unsaved questions and words
  index: number; // the question's place; past the last one adds a question
  type: Settings["fitFinder"]["type"];
  onDone: (q: Question, words: Record<string, string>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { chart: c, index } = props;
  const q = c.fit.questions[index] as Question | undefined;
  const [f, setF] = useState(() => ({
    words: q ? (c.words[`fit.${q.id}`] ?? "") : "",
    kind: q?.kind ?? "measure",
    col: q?.kind === "measure" ? q.col : "",
    optional: q?.kind === "measure" && q.optional,
  }));
  const [checked, setChecked] = useState(false);
  const put = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const kinds = (Object.keys(KINDS) as Kind[]).filter(
    (k) => OFFERED[props.type].includes(k) || k === q?.kind,
  );
  const bad = { qText: !f.words.trim(), qCol: f.kind === "measure" && !f.col };
  const field = (id: keyof typeof bad) =>
    checked && bad[id]
      ? {
          id,
          className: "field bad",
          "aria-invalid": true,
          "aria-describedby": `${id}-err`,
        }
      : { id, className: "field" };
  const err = (id: keyof typeof bad, words: string) =>
    checked &&
    bad[id] && (
      <p id={`${id}-err`} className="help err">
        <s-icon type="alert-circle" tone="critical" size="small" />
        {words}
      </p>
    );

  const done = () => {
    setChecked(true);
    if (bad.qText || bad.qCol) return;
    const id = q?.id ?? newId(c);
    const words = { [`fit.${id}`]: f.words.trim() };
    if (f.kind === "measure")
      return props.onDone(
        { id, kind: "measure", col: f.col, optional: f.optional },
        words,
      );
    if (q?.kind !== "choice" || f.kind !== "choice")
      return props.onDone({ id, kind: f.kind as "fit" }, words);
    // A choice question keeps its answers and their words.
    for (const o of q.options)
      words[`fit.${id}.${o.id}`] = c.words[`fit.${id}.${o.id}`] ?? "";
    props.onDone(q, words);
  };

  return (
    <dialog
      className="q-editor"
      aria-labelledby="q-h"
      ref={(d) => {
        if (d && !d.open) d.showModal();
      }}
      onClose={props.onClose}
    >
      <div className="panel">
        <div className="head">
          <h2 id="q-h">{q ? `Edit question ${index + 1}` : "Add question"}</h2>
          <s-button
            variant="tertiary"
            icon="x"
            accessibilityLabel="Close"
            onClick={props.onClose}
          />
        </div>
        <div className="body">
          <div>
            <label>
              Question
              <input
                type="text"
                maxLength={500}
                placeholder="For example, What's your waist measurement?"
                {...field("qText")}
                value={f.words}
                onChange={(e) => put({ words: e.target.value })}
              />
            </label>
            {err("qText", "Enter the question shoppers see.")}
          </div>
          <fieldset>
            <legend>Kind of answer</legend>
            {kinds.map((k) => (
              <label key={k} className="choice">
                <input
                  type="radio"
                  name="qKind"
                  checked={f.kind === k}
                  onChange={() => put({ kind: k })}
                />
                <strong>{KINDS[k][0]}</strong>
                <span className="help">{KINDS[k][1]}</span>
              </label>
            ))}
          </fieldset>
          {f.kind === "measure" && (
            <div className="fields">
              <div>
                <label>
                  Chart column
                  <select
                    {...field("qCol")}
                    value={f.col}
                    onChange={(e) => put({ col: e.target.value })}
                  >
                    {q?.kind !== "measure" && (
                      <option value="">Pick a column</option>
                    )}
                    {c.table.columns.map(
                      (x) =>
                        x.kind === "measure" && (
                          <option key={x.id} value={x.id}>
                            {c.words[`${c.table.id}.${x.id}`] || x.id}
                          </option>
                        ),
                    )}
                  </select>
                </label>
                {err("qCol", "Pick the chart column to match.")}
              </div>
              <label className="choice opt">
                <input
                  type="checkbox"
                  checked={f.optional}
                  onChange={(e) => put({ optional: e.target.checked })}
                />
                <strong>Optional</strong>
                <span className="help">Shoppers can skip it.</span>
              </label>
            </div>
          )}
        </div>
        <div className="foot">
          <div>
            {q && (
              <s-button
                tone="critical"
                disabled={c.fit.questions.length === 1 || undefined}
                onClick={props.onRemove}
              >
                Remove question
              </s-button>
            )}
          </div>
          <div className="row start">
            <s-button onClick={props.onClose}>Cancel</s-button>
            <s-button variant="primary" onClick={done}>
              {q ? "Done" : "Add question"}
            </s-button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
