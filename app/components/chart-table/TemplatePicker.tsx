import { useState } from "react";
import type { Template } from "../../models/chart.server";
import { TEMPLATE_IDS, templateCard } from "../../data/templates";

// The TemplatePicker board: New chart opens it over the size charts list.
// The templates ship with the app, so they never load or fail to.
export function TemplatePicker(props: { onClose: () => void }) {
  const [pick, setPick] = useState<Template>("tops");
  return (
    <dialog
      className="confirm picker"
      aria-labelledby="picker-heading"
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={props.onClose}
    >
      <div className="head">
        <h2 id="picker-heading">New chart: choose a template</h2>
        <button type="button" aria-label="Close" onClick={props.onClose}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path
              d="M5 5l10 10M15 5L5 15"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
        </button>
      </div>
      <div className="body">
        <p>
          A template sets up the measurement columns, size rows and
          how-to-measure steps. You add your own numbers, and you can change any
          of it later.
        </p>
        <div role="group" aria-label="Templates" className="cards">
          {TEMPLATE_IDS.map((t) => {
            const c = templateCard(t);
            return (
              <button
                key={t}
                type="button"
                className="tcard"
                aria-pressed={t === pick}
                onClick={() => setPick(t)}
              >
                <span className="top">
                  {c.name}
                  {t === pick && <span className="badge">Selected</span>}
                </span>
                <span className="line">
                  <b>Measurements</b>
                  <span>{c.measures}</span>
                </span>
                <span className="line">
                  <b>Size rows</b>
                  <span>{c.sizes}</span>
                </span>
                <span className="line">
                  <b>Also</b>
                  <span>{c.extra}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="foot">
        <s-button onClick={props.onClose}>Cancel</s-button>
        <s-button
          variant="primary"
          href={`/app/charts/new${pick === "blank" ? "" : `?template=${pick}`}`}
        >
          {pick === "blank"
            ? "Start blank chart"
            : `Use ${templateCard(pick).name} template`}
        </s-button>
      </div>
    </dialog>
  );
}
