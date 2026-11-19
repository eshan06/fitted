import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { resetCachedPlan } from "../models/billing.server";

// Deletes the sessions on every delivery, retries included, session or not:
// after an uninstall Shopify refuses to refresh an expired token, so the library
// returns no session though its row is still there (§14). The plan starts over
// on Free (§8).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);
  await db.session.deleteMany({ where: { shop } });
  await resetCachedPlan(shop);
  console.log(
    JSON.stringify({
      level: "info",
      msg: "App uninstalled: sessions deleted, plan reset to Free",
      shop,
      route: "webhooks/app/uninstalled",
    }),
  );
  return new Response();
};
