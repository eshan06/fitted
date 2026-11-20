import { useState } from "react";
import * as model from "./model";

// The Editor board's "Paste a whole chart": empty, table found, and no table
// found. The text stays in a textarea and is read with model.readPaste, so it
// never runs as HTML.
export function PasteDialog(props: {
  onClose: () => void;
  onFill: (p: model.Pasted) => void;
}) {
  const [text, setText] = useState("");
  const pasted = model.readPaste(text);
  const bad = !!text.trim() && !pasted;
  return (
    <dialog
      className="confirm paste"
      aria-labelledby="paste-heading"
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={props.onClose}
    >
      <div className="head">
        <h2 id="paste-heading">Paste a whole chart</h2>
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
          Copy the table from your spreadsheet or supplier sheet, header row
          included, and paste it here.
        </p>
        <label>
          Table to paste
          <textarea
            className={`field${bad ? " bad" : ""}`}
            rows={7}
            placeholder="Paste here"
            aria-invalid={bad || undefined}
            aria-describedby={bad ? "paste-err" : undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the dialog's one field
            autoFocus
          />
        </label>
        {!text.trim() && (
          <p className="help">
            Sizes go in the first column and measurements in the rest.
          </p>
        )}
        {pasted && (
          <div role="status" className="found">
            <strong>{model.found(pasted)}</strong>
            <span>
              Filling replaces what&apos;s in the table now. Until you save,
              Discard brings it back.
            </span>
          </div>
        )}
        {bad && (
          <p role="alert" id="paste-err" className="err">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M12 7.5v5.5M12 16.5v.01"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            Fitted couldn&apos;t find a table in this. Copy whole rows and
            columns from a spreadsheet, with sizes in the first column.
          </p>
        )}
      </div>
      <div className="foot">
        <s-button onClick={props.onClose}>Cancel</s-button>
        {pasted ? (
          <s-button variant="primary" onClick={() => props.onFill(pasted)}>
            Replace the table
          </s-button>
        ) : (
          <s-button variant="primary" disabled>
            Fill the table
          </s-button>
        )}
      </div>
    </dialog>
  );
}
