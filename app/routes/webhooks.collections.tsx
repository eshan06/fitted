import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logError, resolveCollection } from "../models/rules.server";

// collections/update and collections/delete (ARCHITECTURE §6, §16): products
// joined or left the collection, so resolve again when a rule names it. A
// failure answers 500, so Shopify retries.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, payload } = await authenticate.webhook(request);
  const id = Number(payload?.id);
  if (!admin || !Number.isSafeInteger(id) || id <= 0) return new Response(); // uninstalled, or nothing to resolve
  try {
    await resolveCollection(admin, shop, `gid://shopify/Collection/${id}`);
  } catch (err) {
    if (err instanceof Response) throw err;
    logError(shop, "webhooks/collections", "Collection check failed", err);
    return new Response(undefined, { status: 500 });
  }
  return new Response();
};
