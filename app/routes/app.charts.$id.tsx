// The chart editor's reads and saves (ARCHITECTURE §5, §8, §15): load a chart
// or mint a new chart's handle, with what the live preview draws with (§7,
// §9), then create, update, publish, unpublish or duplicate it.
import { randomInt } from "node:crypto";
import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import {
  Link,
  data,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { authenticate } from "../shopify.server";
import {
  type Admin,
  AdminApiError,
  canReadProducts,
  pricingPlansUrl,
} from "../models/admin.server";
import { discardImage, readFile, uploadImage } from "../models/files.server";
import { IMAGE_MAX, imageType } from "../lib/image-file";
import {
  ChartConflictError,
  ChartNotFoundError,
  ChartValidationError,
  TEMPLATES,
  countActiveCharts,
  countChartProducts,
  createChart,
  duplicateChart,
  getChart,
  publishChart,
  unpublishChart,
  updateChart,
  validateChart,
} from "../models/chart.server";
import {
  FREE_ACTIVE_CHARTS,
  canPublishChart,
  getPlan,
  lastConfirmedPlan,
  type Plan,
} from "../models/billing.server";
import { SettingsReadWriteError, getSettings } from "../models/settings.server";
import { startResolve } from "../models/rules.server";
import { guideWords } from "../models/guide-words.server";
import {
  createdSummary,
  recordVersion,
  staffName,
} from "../models/chart-history.server";
import { Editor } from "../components/chart-table/Editor";
import {
  blankDraft,
  storedDraft,
  toDraft,
} from "../components/chart-table/model";

const ROUTE = "app.charts.$id";
// Thrown as a Response (§15); the app's error boundary prints its text.
const notFound = () =>
  new Response("This chart doesn't exist. It may have been deleted.", {
    status: 404,
  });
const gid = (id: string | undefined) => {
  if (!id || !/^\d{1,20}$/.test(id)) throw notFound();
  return `gid://shopify/Metaobject/${id}`;
};
const logShopifyError = (shop: string, err: Error & { detail?: string }) =>
  console.log(
    JSON.stringify({
      level: "error",
      msg: err.message,
      shop,
      route: ROUTE,
      detail: err.detail,
    }),
  );

// Minted once per visit and resent on every retry, so a retried create or
// duplicate lands on one chart (§5).
const mint = () => {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `c-${Array.from({ length: 10 }, () => a[randomInt(36)]).join("")}`;
};

// What the live preview draws with besides the chart, as the storefront
// reads it: the Appearance settings and the plan (§7, §8).
async function lookOf(admin: Admin, plan: Plan) {
  const { settings, primaryLocale } = await getSettings(admin);
  return { settings, primaryLocale, plan, words: guideWords };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const isNew = params.id === "new";
  const id = isNew ? "" : gid(params.id);
  // The preview's Find my size is Pro's, so the shell reloads the editor
  // when a check confirms another plan (§8).
  const planAtLoad = await lastConfirmedPlan(session.shop);
  try {
    if (isNew) {
      const handle = mint();
      // The template picker's choice; anything else starts blank (§5).
      const t = new URL(request.url).searchParams.get("template");
      const template = TEMPLATES.find((x) => x === t) ?? "blank";
      const look = await lookOf(admin, planAtLoad.plan);
      return { mode: "new" as const, handle, template, planAtLoad, look };
    }
    const [stored, look, counts] = await Promise.all([
      getChart(admin, id),
      lookOf(admin, planAtLoad.plan),
      countChartProducts(admin, [id]),
    ]);
    return {
      mode: "edit" as const,
      stored,
      planAtLoad,
      look: { ...look, products: counts[id] },
      copyHandle: mint(),
    };
  } catch (err) {
    if (err instanceof ChartNotFoundError) throw notFound();
    if (
      !(err instanceof AdminApiError) &&
      !(err instanceof SettingsReadWriteError)
    )
      throw err;
    logShopifyError(session.shop, err);
    return data(
      {
        mode: "error" as const,
        error: {
          code: "shopify",
          message:
            "Fitted couldn't reach your store just now. Nothing about the chart has changed, and shoppers still see it as before.",
        },
      },
      { status: 502 },
    );
  }
};

const fail = (status: number, code: string, message: string) =>
  data({ error: { code, message } }, { status });

// The How to measure image: at most the file and its form's fields are read,
// the file is checked by its name and bytes, and it goes on to Shopify Files.
// The chart holds it once the editor saves.
async function upload(request: Request, admin: Admin, shop: string) {
  const file = await readFile(request, IMAGE_MAX + 64 * 1024);
  const bytes =
    file instanceof File && new Uint8Array(await file.arrayBuffer());
  const mime = bytes && imageType(file.name, bytes);
  if (!bytes || !mime || bytes.length > IMAGE_MAX)
    return data(
      { fieldErrors: { measureImage: "Use a PNG or JPG up to 20 MB." } },
      { status: 422 },
    );
  try {
    return {
      image: await uploadImage(admin, shop, { name: file.name, mime, bytes }),
    };
  } catch (err) {
    if (!(err instanceof AdminApiError)) throw err;
    logShopifyError(shop, err);
    return fail(
      502,
      "upload",
      "Shopify didn't answer, so the chart has no drawing yet.",
    );
  }
}

// An upload the editor let go before a save: deleted only with the `sig` its
// upload answered within the hour, and only while no chart holds it, so no
// other file is ever touched.
async function discard(request: Request, admin: Admin, shop: string) {
  const form = await request.formData().catch(() => null);
  const id = form?.get("id");
  const sig = form?.get("sig");
  if (typeof id !== "string" || typeof sig !== "string")
    return data(
      { fieldErrors: { id: "Must be an uploaded image" } },
      { status: 422 },
    );
  try {
    const done = await discardImage(admin, shop, id, sig);
    if (done === "not_fitted")
      return fail(403, done, "Fitted didn't upload this file.");
    if (done === "expired")
      return fail(
        403,
        done,
        "This upload is over an hour old, so Fitted keeps it. Delete it in Settings > Files if you don't need it.",
      );
    if (done === "saved")
      return fail(409, done, "A chart uses this image, so Fitted keeps it.");
    return { discarded: id };
  } catch (err) {
    if (!(err instanceof AdminApiError)) throw err;
    logShopifyError(shop, err);
    return fail(502, "shopify", "Shopify didn't delete the image.");
  }
}

// Duplicate: a Draft copy of the saved chart, which the editor then opens.
// The copy's first version reads as a first save does.
async function duplicate(
  admin: Admin,
  shop: string,
  by: string,
  id: string,
  handle: unknown,
) {
  try {
    const copy = await duplicateChart(admin, id, handle);
    const kept =
      !!copy.chart && (await recordVersion(shop, copy.id, copy.chart, by));
    return {
      duplicated: copy.id.split("/").pop()!,
      ...(kept ? {} : { historyMissed: true as const }),
    };
  } catch (err) {
    if (err instanceof ChartValidationError)
      return data({ fieldErrors: err.fieldErrors }, { status: 422 });
    if (err instanceof ChartNotFoundError) throw notFound();
    if (!(err instanceof AdminApiError)) throw err;
    logShopifyError(shop, err);
    return fail(502, "shopify", "Shopify didn't respond, so no copy was made.");
  }
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  if (request.headers.get("content-type")?.startsWith("multipart/form-data"))
    return upload(request, admin, session.shop);
  if (request.method === "DELETE") return discard(request, admin, session.shop);
  const isNew = params.id === "new";
  const id = isNew ? "" : gid(params.id);
  const body = await request.json().catch(() => null);
  if (!isNew && typeof body === "object" && body && "duplicate" in body)
    return duplicate(
      admin,
      session.shop,
      staffName(session),
      id,
      body.duplicate,
    );
  try {
    if (typeof body !== "object" || body === null)
      throw new ChartValidationError({ "": "Must be a chart" });
    const input = validateChart(body.chart);
    const by = staffName(session);
    if (isNew) {
      const created = await createChart(admin, body.handle, body.chart);
      const ok = await recordVersion(
        session.shop,
        created.id,
        input,
        by,
        createdSummary(input),
      );
      // Not a redirect: the editor hides the save bar first, or the admin's
      // address bar stays on /app/charts/new (Editor).
      return {
        created: created.id.split("/").pop()!,
        ...(ok ? {} : { historyMissed: true as const }),
      };
    }
    const { status } = body;
    if (status !== "ACTIVE" && status !== "DRAFT")
      throw new ChartValidationError({ status: "Pick Published or Draft" });
    // Free's limit is checked before anything is written (§8).
    // ponytail: two publishes at once can both pass; a per-shop lock if that ever matters.
    if (
      status === "ACTIVE" &&
      (await getChart(admin, id)).status !== "ACTIVE"
    ) {
      const { plan, checkFailed } = await getPlan(session.shop);
      const published = await countActiveCharts(admin);
      if (!canPublishChart(plan, published))
        return data(
          {
            error: {
              code: "plan_limit",
              message: `${checkFailed ? "Fitted couldn't check your plan just now, so it counts as Free. " : ""}Free includes ${FREE_ACTIVE_CHARTS} published charts. Nothing was saved: set this chart to Draft to save your changes, or upgrade to Standard to publish more.`,
              // The banner's numbers and its See plans link.
              limit: FREE_ACTIVE_CHARTS,
              published,
              checkFailed,
              // Without the link the banner still says why and offers Save as Draft.
              plansUrl: await pricingPlansUrl(admin, session.shop).catch(
                (err) => {
                  if (!(err instanceof AdminApiError)) throw err;
                  logShopifyError(session.shop, err);
                  return undefined;
                },
              ),
            },
          },
          { status: 403 },
        );
    }
    const saved = await updateChart(admin, id, body.chart, body.updatedAt);
    const kept = await recordVersion(session.shop, id, input, by);
    const history = kept ? {} : { historyMissed: true as const };
    // A save that lands reloads the chart and remounts the editor, so the
    // note that history missed it travels in the address.
    const done = () =>
      kept
        ? { ok: true as const }
        : redirect(`/app/charts/${params.id}?history=missed`);
    if (saved.status === status) return done();
    // A failed action doesn't reload the chart, so the next save needs the new updatedAt.
    const still = (http: number, code: string, then: string) =>
      data(
        {
          error: {
            code,
            message: `Your edits were saved, but the chart is still ${saved.status === "ACTIVE" ? "Published" : "a Draft"}. ${then}`,
          },
          updatedAt: saved.updatedAt,
          ...history,
        },
        { status: http },
      );
    try {
      // The status moves products onto or off the chart, which the resolve job does with the offline token (§13).
      if (!(await canReadProducts(admin)))
        return still(
          403,
          "product_access",
          "Publishing or unpublishing a chart changes which products show it, which needs the Products permission on your staff account. Ask the store owner to give you Products access in Settings › Users, then save again.",
        );
      await (status === "ACTIVE" ? publishChart : unpublishChart)(admin, id);
    } catch (err) {
      if (!(err instanceof AdminApiError)) throw err;
      logShopifyError(session.shop, err);
      return still(502, "status", "Change its status and save again.");
    }
    // Every product follows, `auto: false` charts included (§6).
    void startResolve(session.shop, true);
    return done();
  } catch (err) {
    if (err instanceof ChartValidationError)
      return data({ fieldErrors: err.fieldErrors }, { status: 422 });
    if (err instanceof ChartConflictError)
      return fail(409, "conflict", err.message);
    if (err instanceof ChartNotFoundError) throw notFound();
    if (!(err instanceof AdminApiError)) throw err;
    logShopifyError(session.shop, err);
    return fail(
      502,
      "shopify",
      "Fitted couldn't save to Shopify just now, so the chart on your store hasn't changed. Your edits are still here.",
    );
  }
};

// An image's upload or discard changes no chart, so the chart isn't read
// again, and a new chart keeps the handle its loader minted. A duplicate's
// reload still runs: it can be the one that brings in a save landing
// alongside it, whose own reload the router drops for the newer one.
export const shouldRevalidate: ShouldRevalidateFunction = (a) =>
  a.formEncType !== "multipart/form-data" &&
  a.formMethod?.toUpperCase() !== "DELETE" &&
  a.defaultShouldRevalidate;

// The Editor board's states: the editor itself, loading, couldn't load, and a
// stored chart that fails the checks (opened with its values marked when the
// table can be drawn, else its banner alone).
export default function ChartEditor() {
  const loaded = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  // A save that history missed lands on ?history=missed (the action). The
  // note holds until the chart next reloads, and leaves the address so a
  // reload doesn't repeat it. Effects run in order: a missed save reloads
  // the chart and sets the note in the same render.
  const [missed, setMissed] = useState(false);
  const [params, setParams] = useSearchParams();
  const s = loaded.mode === "edit" ? loaded.stored : undefined;
  const at = s && `${s.id}|${s.updatedAt}`;
  useEffect(() => setMissed(false), [at]);
  useEffect(() => {
    if (params.get("history") !== "missed") return;
    setMissed(true);
    const rest = new URLSearchParams(params);
    rest.delete("history");
    setParams(rest, { replace: true });
  }, [params, setParams]);
  // Duplicate's handle holds while this chart stays open, through the
  // editor's rebuild on each save and a reload that failed, so a duplicate
  // retried after either still lands on one copy (§5).
  const fresh =
    loaded.mode === "edit"
      ? { id: loaded.stored.id, handle: loaded.copyHandle }
      : undefined;
  const [copy, setCopy] = useState(fresh);
  if (fresh && fresh.id !== copy?.id) setCopy(fresh);
  if (loaded.mode === "new")
    return (
      <Editor
        key="new"
        initial={blankDraft(loaded.template)}
        handle={loaded.handle}
        look={loaded.look}
      />
    );
  const initial = s?.chart
    ? toDraft(s.chart, s.status)
    : s && storedDraft(s.raw, s.status, s.fieldErrors);
  // A copy opened from Duplicate can share the chart's updatedAt and status.
  if (s && initial)
    return (
      <Editor
        key={`${s.id}|${s.updatedAt}|${s.status}`}
        initial={initial}
        updatedAt={s.updatedAt}
        invalid={s.fieldErrors}
        historyMissed={missed}
        imageUrl={s.measureImageUrl}
        look={loaded.mode === "edit" ? loaded.look : undefined}
        copyHandle={copy?.handle}
      />
    );
  const invalid = loaded.mode === "edit" ? loaded.stored.fieldErrors : null;
  const count = Object.keys(invalid ?? {}).length;
  return (
    <s-page>
      <div className="editor">
        <Link to="/app/charts">Size charts</Link>
        {revalidator.state === "loading" ? (
          <div role="status" className="card">
            <span className="visually-hidden">Loading chart</span>
            <span className="sk" />
            <span className="sk short" />
          </div>
        ) : invalid ? (
          // Too broken to draw as a table: Fitted never wrote it.
          <s-banner
            tone="critical"
            heading={`Fix ${count} ${count === 1 ? "value" : "values"} to save this chart`}
          >
            They were changed outside Fitted. Nothing on your store has changed.
          </s-banner>
        ) : (
          <>
            <s-banner tone="critical" heading="This chart didn't load">
              Fitted couldn&apos;t reach your store just now. Nothing about the
              chart has changed, and shoppers still see it as before.
              <s-button
                slot="secondary-actions"
                onClick={() => revalidator.revalidate()}
              >
                Try again
              </s-button>
            </s-banner>
            <p className="help">
              Still not working? Email [SUPPORT EMAIL] and we&apos;ll look into
              it.
            </p>
          </>
        )}
      </div>
    </s-page>
  );
}
