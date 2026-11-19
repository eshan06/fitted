import type { FieldErrors } from "../../models/chart.server";
import { type Draft, setCell, setWord } from "./model";

// The first table as an editable sheet. Headers and size, country and text
// cells are words; measure cells are typed numbers (model.ts).
export function ChartTable({
  draft,
  errors,
  onChange,
}: {
  draft: Draft;
  errors: FieldErrors;
  onChange: (d: Draft) => void;
}) {
  const t = draft.content.tables[0];
  const words = draft.content.words;
  const problems: string[] = [];
  const cell = (
    key: string,
    value: string,
    set: (v: string) => Draft,
    label: string,
    error?: string,
  ) => {
    if (error) problems.push(`${label}: ${error}`);
    return (
      <input
        className={error ? "field cell bad" : "field cell"}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        title={error}
        value={value}
        onChange={(e) => onChange(set(e.target.value))}
        key={key}
      />
    );
  };
  const colName = (id: string, i: number) =>
    words[`${t.id}.${id}`] || (i === 0 ? "Size" : "Measurement");
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="sheet">
        <thead>
          <tr>
            {t.columns.map((col, i) => {
              const key = `${t.id}.${col.id}`;
              return (
                <th scope="col" key={col.id}>
                  {cell(
                    key,
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
            const size = words[`${t.id}.${row.id}.size`] || `row ${ri + 1}`;
            return (
              <tr key={row.id}>
                {t.columns.map((col, i) => {
                  const label = `${size}, ${colName(col.id, i)}`;
                  if (col.kind === "measure") {
                    const k = `${row.id}.${col.id}`;
                    return (
                      <td key={col.id}>
                        {cell(
                          k,
                          draft.cells[k] ?? "",
                          (v) => setCell(draft, row.id, col.id, v),
                          label,
                          errors[`content.tables.0.rows.${ri}.cells.${col.id}`],
                        )}
                      </td>
                    );
                  }
                  const key = `${t.id}.${row.id}.${col.id}`;
                  return (
                    <td key={col.id}>
                      {cell(
                        key,
                        words[key] ?? "",
                        (v) => setWord(draft, key, v),
                        i === 0 ? `Size ${ri + 1}` : label,
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
      {problems.length > 0 && (
        <ul className="err">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
