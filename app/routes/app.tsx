import { Suspense } from "react";
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
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import {
  getPlan,
  planConfirmedAt,
  type Plan,
  type PlanState,
} from "../models/billing.server";

export type PlanCheck = PlanState & { confirmed: string | null };

// The plan for every admin load (ARCHITECTURE §8), streamed so a slow check
// never holds up the screen. A screen can read it from here instead of calling
// getPlan in its own loader; gated actions call getPlan themselves.
async function planCheck(shop: string): Promise<PlanCheck> {
  try {
    const state = await getPlan(shop);
    const at = state.checkFailed ? await planConfirmedAt(shop) : null;
    const confirmed =
      at?.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }) ?? null;
    return { ...state, confirmed };
  } catch (error) {
    // The billing module's rule for a plan it can't confirm: Free.
    console.log(
      JSON.stringify({
        level: "error",
        msg: "Plan check failed",
        shop,
        route: "app",
        error: String(error),
      }),
    );
    return { plan: "free", checkFailed: true, confirmed: null };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  if (url.searchParams.has("plan_handle")) {
    // The welcome link after a plan change: re-check at once, then load the
    // same page without the param, so its revalidations don't each re-check.
    // The redirected load joins this check, and reports it if it fails.
    getPlan(session.shop, { recheck: true }).catch(() => {});
    url.searchParams.delete("plan_handle");
    throw redirect(url.pathname + url.search);
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
        <Await resolve={plan}>
          {(check) => <PlanCheckBanner {...check} />}
        </Await>
      </Suspense>
      <Outlet />
    </AppProvider>
  );
}

const PLAN_NAMES: Record<Plan, string> = {
  free: "Free",
  standard: "Standard",
  pro: "Pro",
};

// The canvas's "Couldn't check plan" state, on every admin page.
function PlanCheckBanner({ plan, checkFailed, confirmed }: PlanCheck) {
  const fetcher = useFetcher();
  if (!checkFailed) return null;
  // A plan never confirmed has no date to give.
  const since = confirmed ? ` (last confirmed ${confirmed})` : "";
  return (
    <s-banner tone="warning" heading="Couldn't check your plan">
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
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
