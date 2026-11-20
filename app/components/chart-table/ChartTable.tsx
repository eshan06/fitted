import type { FieldErrors } from "../../models/chart.server";
import { type Draft, type Problem, setCell, setWord } from "./model";

// The first table as an editable sheet. Headers and size, country and text
// cells are words; measure cells are typed numbers (model.ts). Each input's id
// is the one the banner links to (model.problems).
export function ChartTable(props: {
  draft: Draft;
  errors: FieldErrors;
  problems: Problem[];
  onChange: (d: Draft) => void;
}) {
  const { draft, errors, onChange } = props;
  const t = draft.content.tables[0];
  const words = draft.content.words;
  const word = (key: string) => ({
    value: words[key] ?? "",
    set: (v: string) => setWord(draft, key, v),
    error: errors[`content.words.${key}`],
  });
  const input = (
    id: string,
    label: string,
    f: { value: string; set: (v: string) => Draft; error?: string },
  ) => (
    <input
      id={id}
      className={f.error ? "field cell bad" : "field cell"}
      aria-label={label}
      aria-invalid={f.error ? true : undefined}
      aria-describedby={f.error ? `${id}-err` : undefined}
      value={f.value}
      onChange={(e) => onChange(f.set(e.target.value))}
    />
  );
  const listed = props.problems.filter((p) => p.id?.startsWith("cell-"));
  return (
    <>
      <div className="scroll">
        <table className="sheet">
          <thead>
            <tr>
              {t.columns.map((col, i) => (
                <th scope="col" key={col.id}>
                  {input(
                    `cell-h-${col.id}`,
                    `Column ${i + 1} name`,
                    word(`${t.id}.${col.id}`),
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
                <tr key={row.id}>
                  {t.columns.map((col, i) => {
                    const k = `${row.id}.${col.id}`;
                    const name = words[`${t.id}.${col.id}`] || "Measurement";
                    return (
                      <td key={col.id}>
                        {input(
                          `cell-${row.id}-${col.id}`,
                          i ? `${size}, ${name}` : `Size ${ri + 1}`,
                          col.kind === "measure"
                            ? {
                                value: draft.cells[k] ?? "",
                                set: (v) => setCell(draft, row.id, col.id, v),
                                error:
                                  errors[
                                    `content.tables.0.rows.${ri}.cells.${col.id}`
                                  ],
                              }
                            : word(`${t.id}.${k}`),
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
    </>
  );
}
