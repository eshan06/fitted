// Every chart as one CSV file, on every plan (ARCHITECTURE §8, §13). A resource
// route: the parent's loader doesn't run, so this one authenticates (§3).
import type { LoaderFunctionArgs } from "react-router";
import { AdminApiError } from "../models/admin.server";
import { chartPages, type StoredChart } from "../models/chart.server";
import { exportCsv } from "../models/csv-import.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  // ponytail: the whole file is built in memory; stream it if stores keep thousands of charts.
  const charts: StoredChart[] = [];
  try {
    for await (const page of chartPages(admin)) charts.push(...page);
  } catch (err) {
    if (!(err instanceof AdminApiError)) throw err;
    console.log(
      JSON.stringify({
        level: "error",
        msg: "Chart export failed",
        shop: session.shop,
        route: "app.export",
        detail: err.detail,
      }),
    );
    const message =
      "Shopify didn't answer, so nothing was exported. Try again.";
    return Response.json(
      { error: { code: "shopify", message } },
      { status: 502 },
    );
  }
  const day = new Date().toISOString().slice(0, 10);
  return new Response(exportCsv(charts), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="fitted-charts-${day}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
