// The VersionHistory board (Fitted canvas): a chart's saved versions and a read
// only preview of one against the current chart (ARCHITECTURE §5). Restore
// joins it with #153.
import { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, data, useLoaderData, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import { AdminApiError } from "../models/admin.server";
import {
  type ChartInput,
  ChartNotFoundError,
  getChart,
} from "../models/chart.server";
import {
  VERSION_LIMIT,
  listVersions,
  shopTimeZone,
  versionTime,
} from "../models/chart-history.server";
import { formatCell } from "../components/chart-table/model";
import "../components/chart-table/editor.css";

const ROUTE = "app.charts.$id.history";
const notFound = () =>
  new Response("This chart doesn't exist. It may have been deleted.", {
    status: 404,
  });
const gid = (id: string | undefined) => {
  if (!id || !/^\d{1,20}$/.test(id)) throw notFound();
  return `gid://shopify/Metaobject/${id}`;
};
// Shopify's or the database's raw error is logged, never shown (§15).
const logError = (shop: string, err: unknown) =>
  console.log(
    JSON.stringify({
      level: "error",
      msg: "Version history failed",
      shop,
      route: ROUTE,
      // Shopify's raw text, or only the error's name: a database message can
      // echo query values.
      detail:
        err instanceof AdminApiError
          ? err.detail
          : err instanceof Error
            ? err.name
            : "unknown",
    }),
  );

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const id = gid(params.id);
  try {
    const [stored, timeZone, versions] = await Promise.all([
      getChart(admin, id),
      shopTimeZone(admin),
      listVersions(session.shop, id),
    ]);
    return {
      name: stored.name,
      // Sent with the data: the client can't import a .server module.
      limit: VERSION_LIMIT,
      current: stored.chart ?? null,
      versions: versions.map((v) => ({
        id: v.id,
        when: versionTime(v.createdAt, timeZone),
        by: v.by,
        what: v.summary,
        // ponytail: every snapshot in one load, at most 30 charts of 100 KB; load one per pick if that gets slow.
        chart: v.snapshot as ChartInput,
      })),
    };
  } catch (err) {
    if (err instanceof ChartNotFoundError) throw notFound();
    if (err instanceof Response) throw err;
    logError(session.shop, err);
    // The screen shows the board's own error copy (§15).
    return data(
      {
        error: {
          code: err instanceof AdminApiError ? "shopify" : "server",
          message:
            "Fitted couldn't load this chart's versions just now. The chart itself is fine.",
        },
      },
      { status: 502 },
    );
  }
};

// A cell as shoppers read it: a measurement's numbers, else its words.
function cellText(c: ChartInput | null, row: string, col: string) {
  const t = c?.content.tables[0];
  const column = t?.columns.find((x) => x.id === col);
  if (!t || !column || !t.rows.some((r) => r.id === row)) return "";
  if (column.kind !== "measure")
    return c.content.words[`${t.id}.${row}.${col}`] ?? "";
  const cell = t.rows.find((r) => r.id === row)?.cells[col];
  return cell ? formatCell(cell) : "";
}

const w = (width: string, height?: string) => ({ width, height });

export default function VersionHistory() {
  const loaded = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [sel, setSel] = useState<number>();

  const header = (name?: string) => (
    <div>
      {name ? (
        <Link to=".." relative="path">
          {name}
        </Link>
      ) : (
        <Link to="/app/charts">Size charts</Link>
      )}
      <h1>Version history</h1>
      <p className="help">
        Every save keeps the version before it. Restoring an old version saves
        it as a new one, so nothing is lost.
      </p>
    </div>
  );
  const back = (
    <Link className="btn2" to=".." relative="path">
      Back to the chart
    </Link>
  );

  if (revalidator.state === "loading")
    return (
      <s-page>
        <div className="editor history">
          {header("error" in loaded ? undefined : loaded.name)}
          <span className="visually-hidden" role="status">
            Loading versions
          </span>
          {/* The cards alone, so the columns' :first-child rules hold. */}
          <div className="split" aria-busy="true">
            <div className="card sks" aria-hidden="true">
              <span className="sk" style={w("40%")} />
              {[60, 55, 65, 50].map((n) => (
                <div className="skv" key={n}>
                  <span className="sk" style={w(`${n}%`)} />
                  <span className="sk" style={w("30%", "10px")} />
                  <span className="sk" style={w("60%", "10px")} />
                </div>
              ))}
            </div>
            <div className="card" aria-hidden="true">
              <span className="sk" style={w("35%", "16px")} />
              <span className="sk" style={w("20%", "10px")} />
              <span className="sk" style={w("100%", "200px")} />
            </div>
          </div>
        </div>
      </s-page>
    );

  if ("error" in loaded)
    return (
      <s-page>
        <div className="editor history">
          {header()}
          <section className="card alert" role="alert" aria-labelledby="err">
            <h2 id="err">We couldn&apos;t load this chart&apos;s versions</h2>
            <p>
              Only the history failed to load. The chart itself is fine, and
              shoppers still see the current version.
            </p>
            <div className="row start">
              <s-button
                variant="primary"
                onClick={() => revalidator.revalidate()}
              >
                Try again
              </s-button>
              {back}
            </div>
          </section>
        </div>
      </s-page>
    );

  const { versions, current, limit } = loaded;
  const picked =
    versions.find((v) => v.id === sel) ?? versions[1] ?? versions[0];
  const list = (
    <section className="card" aria-labelledby="vlist">
      <h2 id="vlist" className="small">
        Saved versions
      </h2>
      {versions.map((v, i) => (
        <button
          key={v.id}
          type="button"
          className="ver"
          aria-pressed={v === picked}
          onClick={() => setSel(v.id)}
        >
          <span className="row">
            <strong>{v.when}</strong>
            {i === 0 && <span className="badge">Current</span>}
          </span>
          <span className="help">{v.by}</span>
          <span className="what">{v.what}</span>
        </button>
      ))}
      <p className="help">
        Fitted keeps the last {limit} versions of each chart.
      </p>
    </section>
  );

  return (
    <s-page>
      <div className="editor history">
        {header(loaded.name)}
        <div className="split">
          {list}
          {versions.length < 2 ? (
            <section className="card center" aria-labelledby="one">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#5C5F62"
                strokeWidth="1.6"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              <h2 id="one">Only one version so far</h2>
              <p>
                This is the chart as it was first saved. Next time you save a
                change, the version before it shows up here, and you can go back
                to it.
              </p>
              {back}
            </section>
          ) : (
            <Preview
              version={picked}
              isCurrent={picked === versions[0]}
              current={current}
            />
          )}
        </div>
      </div>
    </s-page>
  );
}

function Preview(props: {
  version: { when: string; by: string; chart: ChartInput };
  isCurrent: boolean;
  current: ChartInput | null;
}) {
  const { version, isCurrent, current } = props;
  const c = version.chart;
  const t = c.content.tables[0];
  const label = (col: (typeof t.columns)[number]) => {
    const name = c.content.words[`${t.id}.${col.id}`] ?? "";
    return col.kind === "measure"
      ? `${name} (${col.unit ?? c.content.unit})`
      : name;
  };
  const cells = t.rows.map((r) =>
    t.columns.map((col) => {
      const v = cellText(c, r.id, col.id);
      const now = cellText(current, r.id, col.id);
      return { v, now, differs: current !== null && v !== now };
    }),
  );
  const note = c.content.words[`${t.id}.note`]?.trim();
  return (
    <section className="card" aria-labelledby="vprev">
      <div className="row">
        <div>
          <h2 id="vprev">{version.when}</h2>
          <div className="help">
            {isCurrent
              ? `Current version · saved by ${version.by}`
              : `Saved by ${version.by}`}
          </div>
        </div>
        <span className="badge muted">Preview, read only</span>
      </div>
      {cells.flat().some((x) => x.differs) && (
        <div className="row start">
          <svg width="26" height="8" aria-hidden="true">
            <line
              x1="0"
              y1="6"
              x2="26"
              y2="6"
              stroke="#2448A8"
              strokeWidth="2"
              strokeDasharray="4 3"
            />
          </svg>
          Underlined values differ from the current version
        </div>
      )}
      <div className="scroll">
        <table className="sheet">
          <thead>
            <tr>
              {t.columns.map((col) => (
                <th scope="col" key={col.id}>
                  {label(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, ri) => (
              <tr key={r.id}>
                {cells[ri].map((x, ci) => {
                  const Cell = ci === 0 ? "th" : "td";
                  return (
                    <Cell scope={ci === 0 ? "row" : undefined} key={ci}>
                      <span className={x.differs ? "diff" : undefined}>
                        {x.v}
                      </span>
                      {x.differs && (
                        <span className="visually-hidden">
                          {` (now ${x.now || "empty"})`}
                        </span>
                      )}
                    </Cell>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="help">Note under the table: {note}</p>}
    </section>
  );
}
