import { type InputHTMLAttributes, useRef, useState } from "react";
import { Link } from "react-router";
import type { Content, FieldErrors } from "../../models/chart.server";
import * as model from "./model";

// The first table as an editable sheet, under the Editor board's table tools.
// Headers and size, country and text cells are words; measure cells are typed
// numbers (model.ts). Each input's id is the one the banner links to
// (model.problems). Focusing a size or a column name selects it, for its bar
// and Remove; focusing a cell selects it, and Shift with a click or an arrow
// selects the cells between, for Merge cells.
export function ChartTable(props: {
  draft: model.Draft;
  errors: FieldErrors;
  problems: model.Problem[];
  /** `<row>.<col>` of the stored numbers a save drops (model.dropped). */
  dropped: string[];
  onChange: (d: model.Draft) => void;
  onRemove: (sel: model.Selected) => void;
}) {
  const { draft, errors, onChange } = props;
  const [sel, setSel] = useState<model.Selected>();
  const [range, setRange] = useState<{
    col: string;
    from: number;
    to: number;
  }>();
  // Set by Shift on the way to a cell, so its focus extends the range.
  const extend = useRef(false);
  const [confirm, setConfirm] = useState<{
    heading: string;
    text: string;
    label: string;
    run: () => void;
  }>();
  // The column a Remove kept for the fit finder, until another is selected.
  const [kept, setKept] = useState<string>();
  const t = draft.content.tables[0];
  const words = draft.content.words;
  // A removed or discarded size or column is no longer selected.
  const live =
    sel &&
    (sel.row !== undefined ? t.rows : t.columns).some(
      (x) => x.id === (sel.row ?? sel.col),
    );
  const picked = live ? sel : undefined;
  const pickedCol = t.columns.find((c) => c.id === picked?.col);
  const cells: model.Cells | undefined =
    range &&
    t.columns.some((c) => c.id === range.col) &&
    Math.max(range.from, range.to) < t.rows.length
      ? {
          col: range.col,
          a: Math.min(range.from, range.to),
          b: Math.max(range.from, range.to),
        }
      : undefined;
  const merges = model.merges(draft);
  const mergedAt = (ri: number, ci: number) =>
    merges.find((m) => m.r0 === ri && m.c0 === ci);
  // Cells under a merge, other than its top-left one, aren't drawn.
  const covered = new Set(
    merges.flatMap((m) =>
      Array.from(
        { length: m.rows * m.cols },
        (_, i) => `${m.r0 + Math.floor(i / m.cols)},${m.c0 + (i % m.cols)}`,
      ).slice(1),
    ),
  );
  // The selected merged cell; only a merge down one column has its bar.
  const merged =
    cells?.a === cells?.b
      ? merges.find(
          (m) => m.r0 === cells?.a && m.col === cells?.col && m.cols === 1,
        )
      : undefined;
  const wrapCol = picked?.col ?? cells?.col;
  const wrapped = (col?: string) => !!col && !!t.wrap?.includes(col);
  const word = (key: string) => ({
    value: words[key] ?? "",
    set: (v: string) => model.setWord(draft, key, v),
    error: errors[`content.words.${key}`],
  });
  const select = (s: model.Selected) => ({
    onFocus: () => {
      setSel(s);
      setKept(undefined);
      setRange(undefined);
    },
  });
  // A cell's focus selects it, or the cells from the range's start with Shift.
  const selectCell = (
    col: string,
    ri: number,
  ): InputHTMLAttributes<HTMLInputElement> => ({
    onMouseDown: (e) => {
      extend.current = e.shiftKey;
    },
    onKeyDown: (e) => {
      if (!e.shiftKey || !["ArrowDown", "ArrowUp"].includes(e.key)) return;
      const next = t.rows[ri + (e.key === "ArrowDown" ? 1 : -1)];
      const el = next && document.getElementById(`cell-${next.id}-${col}`);
      if (!el) return;
      e.preventDefault();
      extend.current = true;
      el.focus();
    },
    onFocus: () => {
      const from = extend.current && cells?.col === col ? range!.from : ri;
      extend.current = false;
      setSel(undefined);
      setKept(undefined);
      setRange({ col, from, to: ri });
    },
  });
  const input = (
    id: string,
    label: string,
    f: { value: string; set: (v: string) => model.Draft; error?: string },
    focus?: InputHTMLAttributes<HTMLInputElement>,
    drop?: boolean,
  ) => (
    <input
      id={id}
      className={`field cell${f.error ? " bad" : ""}${drop ? " drop" : ""}`}
      aria-label={label}
      aria-invalid={f.error ? true : undefined}
      aria-describedby={f.error ? `${id}-err` : undefined}
      value={f.value}
      onChange={(e) => onChange(f.set(e.target.value))}
      {...focus}
    />
  );
  const focusCell = (row: string, col: string) =>
    setTimeout(() => document.getElementById(`cell-${row}-${col}`)?.focus());
  const removeNow = () => {
    const sel = picked!;
    // Focus goes to the size or column that takes its place, not the page.
    const list = sel.row !== undefined ? t.rows : t.columns;
    const i = list.findIndex((x) => x.id === (sel.row ?? sel.col));
    const next = list[i + 1] ?? list[i - 1];
    props.onRemove(sel);
    setConfirm(undefined);
    if (next)
      focusCell(
        sel.row !== undefined ? next.id : "h",
        sel.row !== undefined ? t.columns[0].id : next.id,
      );
  };
  const ask = () => {
    if (model.fitOnly(draft, picked!.col)) return setKept(picked!.col);
    const r = model.removal(draft, picked!);
    if (r.text) setConfirm({ ...r, text: r.text, run: removeNow });
    else removeNow();
  };
  const mergeNow = (s: model.Cells) => {
    onChange(model.merge(draft, s));
    setConfirm(undefined);
    focusCell(t.rows[s.a].id, s.col);
  };
  const askMerge = () => {
    const r = model.merging(draft, cells!);
    const s = cells!;
    if (r.text) setConfirm({ ...r, text: r.text, run: () => mergeNow(s) });
    else mergeNow(s);
  };
  const mergeable = !!cells && model.canMerge(draft, cells);
  const ri = t.rows.findIndex((r) => r.id === picked?.row);
  const listed = props.problems.filter((p) => p.id?.startsWith("cell-"));
  return (
    <>
      <div role="toolbar" aria-label="Table tools" className="tools">
        <button
          type="button"
          className="btn2"
          disabled={!mergeable}
          onClick={askMerge}
        >
          Merge cells
        </button>
        <button
          type="button"
          className="btn2"
          disabled={!wrapCol}
          aria-pressed={wrapped(wrapCol)}
          onClick={() => onChange(model.toggleWrap(draft, wrapCol!))}
        >
          Wrap text
        </button>
        <label>
          Round to
          <select
            className="field auto"
            value={draft.content.roundTo}
            onChange={(e) =>
              onChange(
                model.setRoundTo(
                  draft,
                  Number(e.target.value) as Content["roundTo"],
                ),
              )
            }
          >
            <option value="0.5">0.5</option>
            <option value="0.25">0.25</option>
            <option value="1">Whole numbers</option>
          </select>
        </label>
      </div>
      {/* Always there, so screen readers announce what gets selected. */}
      <div role="status" aria-live="polite">
        {picked && (
          <div className="selbar">
            <strong>
              {picked.row !== undefined
                ? `Size ${words[`${t.id}.${picked.row}.${t.columns[0].id}`]?.trim() || ri + 1} selected`
                : `${model.colName(draft, picked.col)} column selected`}
            </strong>
            {pickedCol?.kind === "measure" && (
              <>
                <label>
                  Unit
                  <select
                    className="field auto"
                    value={pickedCol.unit ?? draft.content.unit}
                    onChange={(e) =>
                      onChange(
                        model.setMeasure(draft, pickedCol.id, {
                          unit: e.target.value as "in",
                        }),
                      )
                    }
                  >
                    {/* A stored lb or kg shows as what it is. */}
                    {[...new Set(["in", "cm", pickedCol.unit ?? "in"])].map(
                      (u) => (
                        <option key={u}>{u}</option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={!pickedCol.convert}
                    onChange={(e) =>
                      onChange(
                        model.setMeasure(draft, pickedCol.id, {
                          convert: !e.target.checked,
                        }),
                      )
                    }
                  />
                  Don&apos;t convert this column for shoppers
                </label>
              </>
            )}
            <s-button onClick={ask}>
              {model.removal(draft, picked).label}
            </s-button>
          </div>
        )}
        {merged && (
          <div className="selbar">
            <strong>
              {`${model.colName(draft, merged.col)} column, ${model.sizeOf(draft, merged.r0)} to ${model.sizeOf(draft, merged.r0 + merged.rows - 1)} merged`}
            </strong>
            <s-button
              onClick={() => {
                onChange(model.unmerge(draft, merged.row, merged.col));
                focusCell(merged.row, merged.col);
              }}
            >
              Unmerge cells
            </s-button>
            <label>
              <input
                type="checkbox"
                checked={wrapped(merged.col)}
                onChange={() => onChange(model.toggleWrap(draft, merged.col))}
              />
              Wrap text
            </label>
          </div>
        )}
        {cells && cells.a < cells.b && (
          <div className="selbar">
            <strong>
              {`${cells.b - cells.a + 1} cells selected in ${model.colName(draft, cells.col)}, ${model.sizeOf(draft, cells.a)} to ${model.sizeOf(draft, cells.b)}`}
            </strong>
            <s-button disabled={!mergeable} onClick={askMerge}>
              Merge cells
            </s-button>
          </div>
        )}
      </div>
      {/* The Editor board's "Fit finder's only measurement", in place of the dialog. */}
      {kept !== undefined && picked?.col === kept && (
        <div role="alert">
          <s-banner
            tone="warning"
            heading={`${model.colName(draft, kept)} can't be removed`}
          >
            It&apos;s the fit finder&apos;s only measurement. Add another one in{" "}
            <Link to="/app/fit-finder">Fit finder</Link> first.
          </s-banner>
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
                    i ? select({ col: col.id }) : undefined,
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
                    if (covered.has(`${ri},${i}`)) return null;
                    const k = `${row.id}.${col.id}`;
                    const name = words[`${t.id}.${col.id}`] || "Measurement";
                    const m = mergedAt(ri, i);
                    const inRange =
                      cells?.col === col.id && cells.a <= ri && ri <= cells.b;
                    return (
                      <td
                        key={col.id}
                        rowSpan={m?.rows}
                        colSpan={m?.cols}
                        className={
                          picked?.col === col.id || inRange ? "sel" : undefined
                        }
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
                          i ? selectCell(col.id, ri) : select({ row: row.id }),
                          props.dropped.includes(k),
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
          aria-labelledby="confirm-heading"
          ref={(el) => {
            if (el && !el.open) el.showModal();
          }}
          onClose={() => setConfirm(undefined)}
        >
          <div className="head">
            <h2 id="confirm-heading">{confirm.heading}</h2>
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
            <s-button variant="primary" tone="critical" onClick={confirm.run}>
              {confirm.label}
            </s-button>
          </div>
        </dialog>
      )}
    </>
  );
}
