import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { productChanged } from "../models/rules.server";

// products/create and products/update (ARCHITECTURE §6, §16): resolve that
// product's chart. authenticate.webhook checks the signature before anything
// is read. A failure answers 500, so Shopify retries; a repeat finds the chart
// already right and writes nothing.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, payload } = await authenticate.webhook(request);
  if (!session) return new Response(); // uninstalled: nothing to keep assigned
  const { id, updated_at } = payload ?? {};
  const at = typeof updated_at === "string" ? new Date(updated_at) : null;
  if (!Number.isSafeInteger(id) || id <= 0 || !at || Number.isNaN(+at)) {
    console.log(
      JSON.stringify({
        level: "warn",
        msg: "Product webhook without a product id and updated_at",
        shop,
        route: "webhooks/products",
      }),
    );
    return new Response(undefined, { status: 400 });
  }
  return productChanged(shop, `gid://shopify/Product/${id}`, at).then(
    () => new Response(),
    () => new Response(undefined, { status: 500 }), // logged by the model
  );
};
