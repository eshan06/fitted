import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logError, resolveProduct } from "../models/rules.server";

// products/create and products/update (ARCHITECTURE §6, §16): resolve that
// product's chart. A failure answers 500, so Shopify retries; a repeated
// delivery finds the chart already right and writes nothing.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, payload } = await authenticate.webhook(request);
  const id = Number(payload?.id);
  if (!admin || !Number.isSafeInteger(id) || id <= 0) return new Response(); // uninstalled, or nothing to resolve
  try {
    await resolveProduct(
      admin,
      shop,
      `gid://shopify/Product/${id}`,
      payload.updated_at,
    );
  } catch (err) {
    if (err instanceof Response) throw err;
    logError(shop, "webhooks/products", "Product resolve failed", err);
    return new Response(undefined, { status: 500 });
  }
  return new Response();
};
