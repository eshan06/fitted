import { useState } from "react";
import type { FieldErrors } from "../../models/chart.server";
import * as model from "./model";

// The first table as an editable sheet. Headers and size, country and text
// cells are words; measure cells are typed numbers (model.ts). Each input's id
// is the one the banner links to (model.problems). Focusing a size or a column
// name selects it, for its bar and Remove.
export function ChartTable(props: {
  draft: model.Draft;
  errors: FieldErrors;
  problems: model.Problem[];
  onChange: (d: model.Draft) => void;
}) {
  const { draft, errors, onChange } = props;
  const [sel, setSel] = useState<model.Selected>();
  const [confirm, setConfirm] = useState<ReturnType<typeof model.removal>>();
  const t = draft.content.tables[0];
  const words = draft.content.words;
  // A removed or discarded size or column is no longer selected.
  const live =
    sel &&
    (sel.row !== undefined ? t.rows : t.columns).some(
      (x) => x.id === (sel.row ?? sel.col),
    );
  const picked = live ? sel : undefined;
  const word = (key: string) => ({
    value: words[key] ?? "",
    set: (v: string) => model.setWord(draft, key, v),
    error: errors[`content.words.${key}`],
  });
  const input = (
    id: string,
    label: string,
    f: { value: string; set: (v: string) => model.Draft; error?: string },
    select?: model.Selected,
  ) => (
    <input
      id={id}
      className={f.error ? "field cell bad" : "field cell"}
      aria-label={label}
      aria-invalid={f.error ? true : undefined}
      aria-describedby={f.error ? `${id}-err` : undefined}
      value={f.value}
      onChange={(e) => onChange(f.set(e.target.value))}
      onFocus={select && (() => setSel(select))}
    />
  );
  const removeNow = () => {
    onChange(model.remove(draft, picked!));
    setConfirm(undefined);
  };
  const ask = () => {
    const r = model.removal(draft, picked!);
    if (r.text) setConfirm(r);
    else removeNow();
  };
  const ri = t.rows.findIndex((r) => r.id === picked?.row);
  const listed = props.problems.filter((p) => p.id?.startsWith("cell-"));
  return (
    <>
      {picked && (
        <div className="selbar">
          <strong>
            {picked.row !== undefined
              ? `Size ${words[`${t.id}.${picked.row}.${t.columns[0].id}`] || ri + 1} selected`
              : `${model.colName(draft, picked.col)} column selected`}
          </strong>
          <s-button onClick={ask}>
            {picked.row !== undefined ? "Remove size" : "Remove measurement"}
          </s-button>
        </div>
      )}
      <div className="scroll">
        <table className="sheet">
          <thead>
            <tr>
              {t.columns.map((col, i) => (
                <th
                  scope="col"
                  key={col.id}
                  className={picked?.col === col.id ? "sel" : undefined}
                >
                  {input(
                    `cell-h-${col.id}`,
                    `Column ${i + 1} name`,
                    word(`${t.id}.${col.id}`),
                    i ? { col: col.id } : undefined,
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((row, ri) => {
              const size =
                words[`${t.id}.${row.id}.${t.columns[0].id}`] ||
                `Size ${ri + 1}`;
              return (
                <tr
                  key={row.id}
                  className={picked?.row === row.id ? "sel" : undefined}
                >
                  {t.columns.map((col, i) => {
                    const k = `${row.id}.${col.id}`;
                    const name = words[`${t.id}.${col.id}`] || "Measurement";
                    return (
                      <td
                        key={col.id}
                        className={picked?.col === col.id ? "sel" : undefined}
                      >
                        {input(
                          `cell-${row.id}-${col.id}`,
                          i ? `${size}, ${name}` : `Size ${ri + 1}`,
                          col.kind === "measure"
                            ? {
                                value: draft.cells[k] ?? "",
                                set: (v) =>
                                  model.setCell(draft, row.id, col.id, v),
                                error:
                                  errors[
                                    `content.tables.0.rows.${ri}.cells.${col.id}`
                                  ],
                              }
                            : word(`${t.id}.${k}`),
                          i ? undefined : { row: row.id },
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {listed.length > 0 && (
        <ul className="list err">
          {listed.map((p) => (
            <li key={p.id} id={`${p.id}-err`}>
              <strong>{p.where}:</strong> {p.long}
            </li>
          ))}
        </ul>
      )}
      {confirm && (
        <dialog
          className="confirm"
          aria-labelledby="remove-heading"
          ref={(el) => {
            if (el && !el.open) el.showModal();
          }}
          onClose={() => setConfirm(undefined)}
        >
          <div className="head">
            <h2 id="remove-heading">{confirm.heading}</h2>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setConfirm(undefined)}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <path
                  d="M5 5l10 10M15 5L5 15"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
            </button>
          </div>
          <div className="body">
            <p>{confirm.text}</p>
            <p className="help">Until you save, Discard brings them back.</p>
          </div>
          <div className="foot">
            <s-button onClick={() => setConfirm(undefined)}>Cancel</s-button>
            <s-button variant="primary" tone="critical" onClick={removeNow}>
              {confirm.label}
            </s-button>
          </div>
        </dialog>
      )}
    </>
  );
}
