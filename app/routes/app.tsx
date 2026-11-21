import { Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Await,
  Outlet,
  href,
  redirect,
  useFetcher,
  useLoaderData,
  useMatches,
  useRevalidator,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import {
  getPlan,
  lastConfirmedPlan,
  type Plan,
  type PlanState,
} from "../models/billing.server";

// The banner names the plan, never its price; PlanSettle compares `yearly`
// with a screen's. `pending`: the check outlasted the stream, so PlanSettle
// asks for it again after load.
export type PlanCheck = PlanState & {
  confirmed: string | null;
  pending?: true;
};

// The plan for every admin load (ARCHITECTURE §8), streamed so a slow check
// never holds up the screen. Screens load with the last confirmed plan instead
// and PlanSettle reloads one that loaded with another; gated actions call
// getPlan themselves.
async function planCheck(shop: string): Promise<PlanCheck> {
  let state: PlanState | null = null;
  try {
    // A check still running when the stream must close (entry.server.tsx) is
    // asked for again after load; the check itself carries on.
    state = await Promise.race([getPlan(shop), sleep(SHOW_WITHIN_MS)]);
    if (state && !state.checkFailed) return { ...state, confirmed: null };
    const last = await lastConfirmedPlan(shop);
    const confirmed =
      last.at?.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }) ?? null;
    if (state) return { ...state, confirmed };
    // Shown as not answered only if the follow-up gets no answer.
    const { plan, yearly } = last;
    return { plan, yearly, checkFailed: true, confirmed, pending: true };
  } catch (error) {
    console.log(
      JSON.stringify({
        level: "error",
        msg: "Plan check failed",
        shop,
        route: "app",
        error: String(error),
      }),
    );
    // The billing module's rule for a plan it can't confirm: Free.
    const { plan = "free", yearly = null } = state ?? {};
    return { plan, yearly, checkFailed: true, confirmed: null };
  }
}
const SHOW_WITHIN_MS = 4_000; // under entry.server.tsx's 5-second streamTimeout
const sleep = (ms: number) =>
  new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  if (url.searchParams.has("plan_handle")) {
    // The welcome link after a plan change: re-check at once, then load the
    // same page without the param, so its revalidations don't each re-check.
    // The redirected load joins this check, and reports it if it fails.
    getPlan(session.shop, { recheck: true }).catch(() => {});
    url.searchParams.delete("plan_handle");
    // One leading slash: "//host" would leave the app.
    throw redirect(url.pathname.replace(/^\/+/, "/") + url.search);
  }

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    plan: planCheck(session.shop),
  };
};

// Try again on the plan-check banner. A click inside the 10-second gap waits
// for it instead of doing nothing; the loaders then revalidate with the result.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await getPlan(session.shop, { recheck: true });
  return null;
};

// Every navigation is an admin load: the plan and its banner stay current.
export const shouldRevalidate = () => true;

export default function App() {
  const { apiKey, plan } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      {/* href() fails the typecheck when a link names a route that doesn't exist. */}
      <s-app-nav>
        <s-link href={href("/app")}>Home</s-link>
        <s-link href={href("/app/charts")}>Size charts</s-link>
        <s-link href={href("/app/import")}>Import</s-link>
        <s-link href={href("/app/rules")}>Display rules</s-link>
        <s-link href={href("/app/fit-finder")}>Fit finder</s-link>
        <s-link href={href("/app/appearance")}>Appearance & languages</s-link>
      </s-app-nav>
      <Suspense fallback={null}>
        {/* Only past the stream's limit, which planCheck stays under. */}
        <Await resolve={plan} errorElement={null}>
          {(check) => <PlanSettle check={check} />}
        </Await>
      </Suspense>
      <Outlet />
    </AppProvider>
  );
}

// After load: a check still running is asked for again, then a failed one
// shows the banner, and a screen that loaded with another plan reloads. A
// screen that renders by plan loads with the last confirmed one and returns it
// as `planAtLoad`, so a slow check never holds its stream.
function PlanSettle({ check: streamed }: { check: PlanCheck }) {
  // The follow-up's answer, for the check it followed up.
  const [answer, setAnswer] = useState<{ to: PlanCheck; check: PlanCheck }>();
  const check = answer?.to === streamed ? answer.check : streamed;
  useEffect(() => {
    if (!streamed.pending) return;
    let current = true;
    // Plain fetch (App Bridge adds the session token): a failed fetcher would
    // take the screen to the error page.
    fetch("/app/plan-check")
      .then((r) => (r.ok ? (r.json() as Promise<PlanState>) : null))
      .catch(() => null)
      .then((state) => {
        // No answer: not answered, on the last confirmed plan.
        const settled = state
          ? { ...state, confirmed: streamed.confirmed }
          : { ...streamed, pending: undefined };
        if (current) setAnswer({ to: streamed, check: settled });
      });
    return () => {
      current = false;
    };
  }, [streamed]);

  const { revalidate } = useRevalidator();
  const matches = useMatches();
  const stale =
    !check.checkFailed &&
    matches.some(({ loaderData }) => {
      const shown = (
        loaderData as { planAtLoad?: Omit<PlanState, "checkFailed"> } | null
      )?.planAtLoad;
      // Free has no price, so its billing period never shows.
      return (
        shown &&
        (shown.plan !== check.plan ||
          (check.plan !== "free" && shown.yearly !== check.yearly))
      );
    });
  useEffect(() => {
    if (stale) void revalidate();
  }, [stale, revalidate]);
  return check.pending ? null : <PlanCheckBanner {...check} />;
}

const PLAN_NAMES: Record<Plan, string> = {
  free: "Free",
  standard: "Standard",
  pro: "Pro",
};

// The canvas's "Couldn't check plan" state, on every admin page.
function PlanCheckBanner({ plan, checkFailed, confirmed }: PlanCheck) {
  const fetcher = useFetcher();
  // The screen's own s-page, whose supplemental-start slot puts a banner above
  // its content, as drawn. undefined until looked for; null if it has none.
  // Looked for again on every change while shown: a new screen, or one like
  // Fit finder that swaps its loading page for its own.
  const [page, setPage] = useState<Element | null>();
  useEffect(() => {
    if (!checkFailed) return;
    const find = () => setPage(document.querySelector("s-page"));
    find();
    const changes = new MutationObserver(find);
    changes.observe(document.body, { childList: true, subtree: true });
    return () => changes.disconnect();
  }, [checkFailed]);
  if (!checkFailed || page === undefined) return null;
  // A plan never confirmed has no date to give.
  const since = confirmed ? ` (last confirmed ${confirmed})` : "";
  const banner = (
    <s-banner
      slot="supplemental-start"
      tone="warning"
      heading="Couldn't check your plan"
    >
      <s-paragraph>
        {`Shopify didn't answer. Until it does, you keep ${PLAN_NAMES[plan]}${since} and nothing is switched off.`}
      </s-paragraph>
      <s-button
        slot="secondary-actions"
        // React 18 writes `false` as the string "false", which still counts as set.
        {...(fetcher.state !== "idle" && { loading: true })}
        onClick={() => fetcher.submit(null, { method: "post", action: "/app" })}
      >
        Try again
      </s-button>
    </s-banner>
  );
  return page ? createPortal(banner, page) : banner;
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
