// The VersionHistory board (Fitted canvas): a chart's saved versions, a read
// only preview of one against the current chart, and Restore (ARCHITECTURE §5).
import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Link,
  data,
  useFetcher,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  type ChartInput,
  ChartConflictError,
  ChartNotFoundError,
  ChartValidationError,
  getChart,
  updateChart,
} from "../models/chart.server";
import {
  VERSION_LIMIT,
  getVersion,
  listVersions,
  recordVersion,
  shopTimeZone,
  staffName,
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
      detail: err instanceof Error ? `${err.name}: ${err.message}` : "unknown",
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
      // Restore sends it back, so a chart changed since is never overwritten (§5).
      updatedAt: stored.updatedAt,
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
    return data({ error: true as const }, { status: 502 });
  }
};

// `reload`: the page is out of date, so it loads the chart and list again.
const failed = (status: number, message: string, reload?: true) =>
  data({ error: { message, ...(reload && { reload }) } }, { status });

// Restore saves the old snapshot as a new version, so the one it replaces stays
// in the list. Like any save it sends the updatedAt the page loaded, so it
// never writes over a chart that changed since (§5).
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const id = gid(params.id);
  const body = await request.json().catch(() => null);
  try {
    const version = await getVersion(session.shop, id, body?.version);
    // Pruned past the limit by a save elsewhere, or never this chart's.
    if (!version)
      return failed(
        422,
        "This version isn't in the chart's history any more, so nothing was restored. The list now shows the versions Fitted keeps.",
        true,
      );
    const timeZone = await shopTimeZone(admin);
    // A save from the editor clears an import's note (§5).
    const chart = { ...(version.snapshot as ChartInput) };
    delete chart.importNote;
    await updateChart(admin, id, chart, body.updatedAt);
    const day = versionTime(version.createdAt, timeZone).split(" · ")[0];
    const ok = await recordVersion(
      session.shop,
      id,
      chart,
      staffName(session),
      `Restored the ${day} version`,
    );
    return ok ? { ok: true as const } : { ok: true as const, missed: true };
  } catch (err) {
    if (err instanceof ChartNotFoundError) throw notFound();
    if (err instanceof Response) throw err;
    if (err instanceof ChartValidationError)
      return failed(
        422,
        "This version doesn't pass Fitted's checks any more, so it can't be restored. The chart on your store hasn't changed.",
      );
    if (err instanceof ChartConflictError)
      return failed(
        409,
        "This chart changed since you opened it, so nothing was overwritten. The list now shows its latest version. Try again to restore over it.",
        true,
      );
    logError(session.shop, err);
    return failed(
      502,
      "Fitted couldn't save to Shopify just now, so the chart on your store hasn't changed. Try again.",
    );
  }
};

type Answer = {
  ok?: true;
  missed?: true;
  error?: { message: string; reload?: true };
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

export default function VersionHistory() {
  const loaded = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const restore = useFetcher<Answer>();
  const shopify = useAppBridge();
  const [sel, setSel] = useState<number>();
  const [tried, setTried] = useState<number>();
  const [followCurrent, setFollowCurrent] = useState(false);
  const answer = restore.state === "idle" ? restore.data : undefined;
  const { revalidate } = revalidator;
  const handled = useRef<Answer>(undefined);
  useEffect(() => {
    // Each answer acts once, however often the page renders after it.
    if (!answer || handled.current === answer) return;
    handled.current = answer;
    // A failed action doesn't reload the page's data on its own.
    if (answer.error?.reload) revalidate();
    if (!answer.ok) return;
    setFollowCurrent(true);
    shopify.toast.show("Restored. Saved as a new version.");
  }, [answer, shopify, revalidate]);

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

  const w = (width: string, height?: string) => ({ width, height });
  if (revalidator.state === "loading")
    return (
      <s-page>
        <div className="editor history">
          {header("error" in loaded ? undefined : loaded.name)}
          <div className="split" aria-busy="true">
            <span className="visually-hidden">Loading versions</span>
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
              <span className="sk" style={w("160px", "36px")} />
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

  const { versions, current } = loaded;
  const picked = followCurrent
    ? versions[0]
    : (versions.find((v) => v.id === sel) ?? versions[1] ?? versions[0]);
  // Try again sends the version that failed, even if the list changed since.
  const doRestore = (version = picked.id) => {
    setTried(version);
    restore.submit({ version, updatedAt: loaded.updatedAt }, restoreOpts);
  };
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
          onClick={() => {
            setSel(v.id);
            setFollowCurrent(false);
          }}
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
        Fitted keeps the last {VERSION_LIMIT} versions of each chart.
      </p>
    </section>
  );

  return (
    <s-page>
      <div className="editor history">
        {header(loaded.name)}
        {answer?.missed && (
          <s-banner
            tone="warning"
            heading="Saved, but version history missed it"
          >
            <s-paragraph>
              The chart on your store is up to date. This save won&apos;t show
              in version history.
            </s-paragraph>
          </s-banner>
        )}
        {answer?.error && (
          <s-banner tone="critical" heading="This version wasn't restored">
            <s-paragraph>{answer.error.message}</s-paragraph>
            <s-button slot="secondary-actions" onClick={() => doRestore(tried)}>
              Try again
            </s-button>
          </s-banner>
        )}
        {versions.length < 2 ? (
          <div className="split">
            {list}
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
          </div>
        ) : (
          <div className="split">
            {list}
            <Preview
              version={picked}
              isCurrent={picked === versions[0]}
              current={current}
              restoring={restore.state !== "idle"}
              onRestore={() => doRestore()}
            />
          </div>
        )}
      </div>
    </s-page>
  );
}
const restoreOpts = { method: "post", encType: "application/json" } as const;

function Preview(props: {
  version: { when: string; by: string; chart: ChartInput };
  isCurrent: boolean;
  current: ChartInput | null;
  restoring: boolean;
  onRestore: () => void;
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
      <div className="foot">
        <s-button
          variant="primary"
          disabled={isCurrent || props.restoring || undefined}
          loading={props.restoring ? "" : undefined}
          onClick={props.onRestore}
        >
          Restore this version
        </s-button>
        <span className="help grow">
          {isCurrent
            ? "This is the version shoppers see now. Pick an older one to compare or restore it."
            : "Saves this as a new current version. The version you have now stays in the list."}
        </span>
      </div>
    </section>
  );
}
