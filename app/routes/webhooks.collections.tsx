import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { collectionChanged } from "../models/rules.server";

// collections/update and collections/delete (ARCHITECTURE §6, §16): products
// joined or left the collection, so the rules apply again when one names it.
// authenticate.webhook checks the signature before anything is read. A
// failure answers 500, so Shopify retries.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, payload } = await authenticate.webhook(request);
  if (!session) return new Response(); // uninstalled: nothing to keep assigned
  const id = payload?.id;
  if (!Number.isSafeInteger(id) || id <= 0) {
    console.log(
      JSON.stringify({
        level: "warn",
        msg: "Collection webhook without a collection id",
        shop,
        route: "webhooks/collections",
      }),
    );
    return new Response(undefined, { status: 400 });
  }
  return collectionChanged(shop, `gid://shopify/Collection/${id}`).then(
    () => new Response(),
    () => new Response(undefined, { status: 500 }), // logged by the model
  );
};
