// Version history (ARCHITECTURE §5, §14): each save, restore, import or
// template creation adds a ChartVersion row holding the saved chart, who saved
// it and a one-line summary. The chart in Shopify stays the current version.
import { isDeepStrictEqual } from "node:util";
import type { Session } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import type { ChartInput } from "./chart.server";
import { TEMPLATES } from "../components/chart-table/model";

/** The canvas's [VERSION LIMIT]. */
export const VERSION_LIMIT = 30;

/**
 * "Priya N.": first name and last initial only (§3). Offline sessions carry no
 * staff member until online tokens are on (#131), so they read "Staff".
 */
export function staffName(session: Pick<Session, "onlineAccessInfo">) {
  const u = session.onlineAccessInfo?.associated_user;
  // A stored session's missing name reads back as the text "null".
  const name = (n?: string) => (n?.trim() === "null" ? "" : n?.trim());
  const first = name(u?.first_name);
  if (!first) return "Staff";
  const last = name(u?.last_name)?.[0];
  return last ? `${first} ${last.toUpperCase()}.` : first;
}

export const createdSummary = (c: ChartInput) =>
  `Created from the ${TEMPLATES[c.template]} template`;

const and = (l: string[]) =>
  l.length > 1 ? `${l.slice(0, -1).join(", ")} and ${l.at(-1)}` : l[0];

/** What changed from `prev` to `next`, in one line ("Waist for M and L changed"). */
export function summarize(prev: ChartInput, next: ChartInput) {
  const parts: string[] = [];
  const [a, b] = [prev.content.tables[0], next.content.tables[0]];
  const word = (c: ChartInput, k: string) => c.content.words[k]?.trim() ?? "";
  const size = (c: ChartInput, row: string) => {
    const t = c.content.tables[0];
    return word(c, `${t.id}.${row}.${t.columns[0].id}`) || "a size";
  };
  const col = (c: ChartInput, id: string) =>
    word(c, `${c.content.tables[0].id}.${id}`) || "a measurement";
  const sizes = (l: string[]) => (l.length > 4 ? `${l.length} sizes` : and(l));
  const gone = <T extends { id: string }>(x: T[], y: T[]) =>
    x.filter((i) => !y.some((j) => j.id === i.id));

  if (prev.name !== next.name) parts.push(`renamed ${next.name}`);
  if (prev.content.unit !== next.content.unit)
    parts.push(`units set to ${next.content.unit}`);
  const added = gone(b.rows, a.rows).map((r) => size(next, r.id));
  const removed = gone(a.rows, b.rows).map((r) => size(prev, r.id));
  if (added.length) parts.push(`${sizes(added)} added`);
  if (removed.length) parts.push(`${sizes(removed)} removed`);
  gone(b.columns, a.columns).forEach((c) =>
    parts.push(`${col(next, c.id)} added`),
  );
  gone(a.columns, b.columns).forEach((c) =>
    parts.push(`${col(prev, c.id)} removed`),
  );
  for (const c of b.columns) {
    if (c.kind !== "measure" || !a.columns.some((x) => x.id === c.id)) continue;
    const changed = b.rows
      .filter((r) => a.rows.some((x) => x.id === r.id))
      .filter(
        (r) =>
          !isDeepStrictEqual(
            r.cells[c.id],
            a.rows.find((x) => x.id === r.id)!.cells[c.id],
          ),
      )
      .map((r) => size(next, r.id));
    if (changed.length)
      parts.push(`${col(next, c.id)} for ${sizes(changed)} changed`);
  }
  const [n0, n1] = [word(prev, `${a.id}.note`), word(next, `${b.id}.note`)];
  if (n0 !== n1)
    parts.push(`note ${!n0 ? "added" : !n1 ? "removed" : "changed"}`);
  if (!parts.length) parts.push("details changed");
  const line =
    parts.slice(0, 3).join("; ") + (parts.length > 3 ? "; more" : "");
  return line[0].toUpperCase() + line.slice(1);
}

async function latestVersion(shop: string, chartId: string) {
  return db.chartVersion.findFirst({
    where: { shop, chartId },
    orderBy: { id: "desc" },
  });
}

/**
 * Adds a version, called after the chart saved, and drops the chart's versions
 * past the limit. With no `summary`, it says what changed since the last
 * version. A chart identical to the last version adds no row. False when the
 * database failed: the caller tells the merchant history missed the save (§5).
 */
export async function recordVersion(
  shop: string,
  chartId: string,
  chart: ChartInput,
  by: string,
  summary?: string,
) {
  try {
    await record(shop, chartId, chart, by, summary);
    return true;
  } catch (err) {
    console.log(
      JSON.stringify({
        level: "error",
        msg: "Version history write failed",
        shop,
        route: "chart-history",
        detail: err instanceof Error ? err.name : "unknown",
      }),
    );
    return false;
  }
}

async function record(
  shop: string,
  chartId: string,
  chart: ChartInput,
  by: string,
  summary?: string,
) {
  const snapshot = JSON.parse(JSON.stringify(chart)) as ChartInput;
  const last = await latestVersion(shop, chartId);
  const prev = last?.snapshot as ChartInput | undefined;
  if (prev && isDeepStrictEqual(prev, snapshot)) return;
  summary ??= prev ? summarize(prev, snapshot) : "First saved version";
  await db.$transaction(async (tx) => {
    await tx.chartVersion.create({
      data: { shop, chartId, by, summary, snapshot },
    });
    const keep = await tx.chartVersion.findMany({
      where: { shop, chartId },
      orderBy: { id: "desc" },
      take: VERSION_LIMIT,
      select: { id: true },
    });
    await tx.chartVersion.deleteMany({
      where: { shop, chartId, id: { notIn: keep.map((v) => v.id) } },
    });
  });
}

/** Newest first; the first is the current version. */
export const listVersions = (shop: string, chartId: string) =>
  db.chartVersion.findMany({
    where: { shop, chartId },
    orderBy: { id: "desc" },
    take: VERSION_LIMIT,
  });
