// The FitFinder board's question editor (Fitted canvas): Edit and Add question
// open it over the screen. Done or Add question hands the question and its
// words back to the screen's edits; the save bar's Save writes them (§10).
import { useState } from "react";
import type { Question } from "../../lib/fit-finder";
import type { Settings } from "../../models/settings.server";
import { type FitChart, size } from "./chart-fit";

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
// The kinds each fit finder type offers (§7).
const OFFERED: Record<Settings["fitFinder"]["type"], Kind[]> = {
  basic: ["measure", "fit"],
  advanced: ["measure", "usual_size", "fit"],
  custom: ["measure", "usual_size", "fit", "choice"],
};
// A choice question has 1 to 20 answers (the chart's validator).
const MAX_ANSWERS = 20;
// A new id in §5's pattern, not in `used`.
const fresh = (used: string[]) => {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10);
    if (id && !used.includes(id)) return id;
  }
};
// A question's id is unused in the fit table and its questions. The chart's
// validator refuses a repeat in its other tables.
const newId = (c: FitChart) => {
  const t = c.table;
  return fresh(
    [t, ...t.columns, ...t.rows, ...c.fit.questions].map((x) => x.id),
  );
};
type Answer = { id: string; words: string; rows: string[] };
const blank = (as: Answer[]): Answer => ({
  id: fresh(as.map((a) => a.id)),
  words: "",
  rows: [],
});

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
  // A choice question's answers, or one blank answer to start from.
  const [answers, setAnswers] = useState<Answer[]>(() =>
    q?.kind === "choice"
      ? q.options.map((o) => ({
          id: o.id,
          words: c.words[`fit.${q.id}.${o.id}`] ?? "",
          rows: o.rows,
        }))
      : [blank([])],
  );
  const [checked, setChecked] = useState(false);
  const put = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const putAnswer = (i: number, a?: Answer) =>
    setAnswers((as) => {
      const next = [...as];
      next.splice(i, 1, ...(a ? [a] : []));
      return next;
    });
  // Ticking a size keeps the answer's rows in table order (§10).
  const tick = (a: Answer, row: string) =>
    c.table.rows
      .map((r) => r.id)
      .filter((r) => (r === row) !== a.rows.includes(r));
  const kinds = (Object.keys(KINDS) as Kind[]).filter(
    (k) => OFFERED[props.type].includes(k) || k === q?.kind,
  );
  const bad = { qText: !f.words.trim(), qCol: f.kind === "measure" && !f.col };
  const badAnswer = (a: Answer) =>
    f.kind === "choice" && (!a.words.trim() || !a.rows.length);
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
    if (bad.qText || bad.qCol || answers.some(badAnswer)) return;
    const id = q?.id ?? newId(c);
    const words = { [`fit.${id}`]: f.words.trim() };
    if (f.kind === "measure")
      return props.onDone(
        { id, kind: "measure", col: f.col, optional: f.optional },
        words,
      );
    if (f.kind !== "choice")
      return props.onDone({ id, kind: f.kind as "fit" }, words);
    for (const a of answers) words[`fit.${id}.${a.id}`] = a.words.trim();
    const options = answers.map((a) => ({ id: a.id, rows: a.rows }));
    props.onDone({ id, kind: "choice", options }, words);
  };
  // An answer's error line, like the question's own.
  const answerErr = (id: string, words: string) => (
    <p id={id} className="help err">
      <s-icon type="alert-circle" tone="critical" size="small" />
      {words}
    </p>
  );

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
          {f.kind === "choice" && (
            <fieldset className="answers">
              <legend>Answers and the sizes they keep</legend>
              {answers.map((a, i) => {
                const name = a.words.trim() || `Answer ${i + 1}`;
                const noWords = checked && !a.words.trim();
                const noRows = checked && !a.rows.length;
                return (
                  <div key={a.id} className="answer">
                    <label className="words">
                      <span className="visually-hidden">Answer {i + 1}</span>
                      <input
                        type="text"
                        maxLength={500}
                        className={noWords ? "field bad" : "field"}
                        aria-invalid={noWords || undefined}
                        aria-describedby={
                          noWords ? `a${i}-words-err` : undefined
                        }
                        value={a.words}
                        onChange={(e) =>
                          putAnswer(i, { ...a, words: e.target.value })
                        }
                      />
                    </label>
                    <div
                      role="group"
                      aria-label={`Sizes for ${name}`}
                      aria-describedby={noRows ? `a${i}-rows-err` : undefined}
                      className="sizes"
                    >
                      {c.table.rows.map((r) => (
                        <label key={r.id}>
                          <input
                            type="checkbox"
                            checked={a.rows.includes(r.id)}
                            onChange={() =>
                              putAnswer(i, { ...a, rows: tick(a, r.id) })
                            }
                          />
                          {size(c, r.id)}
                        </label>
                      ))}
                    </div>
                    <s-button
                      variant="tertiary"
                      icon="x"
                      accessibilityLabel={`Remove answer ${name}`}
                      disabled={answers.length === 1 || undefined}
                      onClick={() => putAnswer(i)}
                    />
                    {noWords &&
                      answerErr(
                        `a${i}-words-err`,
                        "Enter the answer shoppers see.",
                      )}
                    {noRows &&
                      answerErr(
                        `a${i}-rows-err`,
                        "Pick at least one size for this answer.",
                      )}
                  </div>
                );
              })}
              <div className="row start">
                <s-button
                  disabled={answers.length >= MAX_ANSWERS || undefined}
                  onClick={() => setAnswers((as) => [...as, blank(as)])}
                >
                  Add answer
                </s-button>
                <span className="help">
                  Shoppers who pick an answer only get its sizes.
                </span>
              </div>
            </fieldset>
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
