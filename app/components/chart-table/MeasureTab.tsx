// The Editor board's How to measure tab: the numbered steps, each a name and
// how to measure it. Step n is line n on the drawing, which the next step
// adds beside them.
import * as model from "./model";

export function MeasureTab(props: {
  draft: model.Draft;
  onChange: (d: model.Draft) => void;
}) {
  const { draft, onChange } = props;
  const steps = draft.content.measure.steps;
  const words = draft.content.words;
  const add = (primary = false) => (
    <s-button
      variant={primary ? "primary" : undefined}
      disabled={steps.length >= model.MAX_STEPS}
      onClick={() => {
        const next = model.addStep(draft);
        onChange(next);
        const id = next.content.measure.steps.at(-1);
        setTimeout(() => document.getElementById(`m-${id}-name`)?.focus());
      }}
    >
      Add step
    </s-button>
  );
  const word = (key: string) => ({
    value: words[key] ?? "",
    onChange: (e: { target: { value: string } }) =>
      onChange(model.setWord(draft, key, e.target.value)),
  });
  return (
    <div className="measure">
      <div className="col wide">
        <strong>Steps</strong>
        {steps.length ? (
          <>
            {steps.map((s, i) => (
              <div key={s} className="step">
                <span className="n" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="col">
                  <input
                    id={`m-${s}-name`}
                    className="field"
                    aria-label={`Step ${i + 1} name`}
                    maxLength={500}
                    {...word(`m.${s}.name`)}
                  />
                  <textarea
                    id={`m-${s}-text`}
                    className="field"
                    rows={3}
                    aria-label={`Step ${i + 1}, how to measure`}
                    maxLength={500}
                    {...word(`m.${s}.text`)}
                  />
                </div>
                <button
                  type="button"
                  className="icon"
                  aria-label={`Remove step ${i + 1}`}
                  onClick={() => onChange(model.removeStep(draft, s))}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      d="M6 6l12 12M18 6 6 18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            ))}
            <div className="row start">
              {add()}
              <span className="help">
                Step 1 is line 1 on the drawing. Up to 20 steps.
              </span>
            </div>
          </>
        ) : (
          <div className="drop">
            <strong>No steps yet</strong>
            <span className="help">
              Tell shoppers where to hold the tape, one step per measurement.
            </span>
            {add(true)}
          </div>
        )}
      </div>
    </div>
  );
}
