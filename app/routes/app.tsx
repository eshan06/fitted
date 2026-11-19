import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, href, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

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
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
