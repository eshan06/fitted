import type { FieldErrors } from "../../models/chart.server";
import { type Draft, type Problem, setCell, setWord } from "./model";

// The first table as an editable sheet. Headers and size, country and text
// cells are words; measure cells are typed numbers (model.ts). Every input has
// an id the banner's list links to.
export function ChartTable({
  draft,
  errors,
  problems,
  onChange,
}: {
  draft: Draft;
  errors: FieldErrors;
  problems: Problem[];
  onChange: (d: Draft) => void;
}) {
  const t = draft.content.tables[0];
  const words = draft.content.words;
  const cell = (
    id: string,
    value: string,
    set: (v: string) => Draft,
    label: string,
    error?: string,
  ) => (
    <input
      id={id}
      className={error ? "field cell bad" : "field cell"}
      aria-label={label}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-err` : undefined}
      value={value}
      onChange={(e) => onChange(set(e.target.value))}
    />
  );
  const colName = (id: string, i: number) =>
    words[`${t.id}.${id}`] || (i === 0 ? "Size" : "Measurement");
  const listed = problems.filter((p) => p.id?.startsWith("cell-"));
  return (
    <>
      <div style={{ overflowX: "auto" }}>
        <table className="sheet">
          <thead>
            <tr>
              {t.columns.map((col, i) => {
                const key = `${t.id}.${col.id}`;
                return (
                  <th scope="col" key={col.id}>
                    {cell(
                      `cell-h-${col.id}`,
                      words[key] ?? "",
                      (v) => setWord(draft, key, v),
                      `Column ${i + 1} name`,
                      errors[`content.words.${key}`],
                    )}
                  </th>
                );
              })}
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
                    const id = `cell-${row.id}-${col.id}`;
                    const label = i ? `${size}, ${colName(col.id, i)}` : size;
                    if (col.kind === "measure") {
                      const k = `${row.id}.${col.id}`;
                      return (
                        <td key={col.id}>
                          {cell(
                            id,
                            draft.cells[k] ?? "",
                            (v) => setCell(draft, row.id, col.id, v),
                            label,
                            errors[
                              `content.tables.0.rows.${ri}.cells.${col.id}`
                            ],
                          )}
                        </td>
                      );
                    }
                    const key = `${t.id}.${row.id}.${col.id}`;
                    return (
                      <td key={col.id}>
                        {cell(
                          id,
                          words[key] ?? "",
                          (v) => setWord(draft, key, v),
                          i ? label : `Size ${ri + 1}`,
                          errors[`content.words.${key}`],
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
        <ul className="err">
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
