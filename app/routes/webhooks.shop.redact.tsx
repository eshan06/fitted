import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// 48 hours after an uninstall, Shopify asks for the shop's data to be erased:
// its rows in every app database table (ARCHITECTURE §14). A new table joins
// this list; webhooks.privacy.test.ts fails until it does. Charts live in the
// store, which removes them with the uninstall (§4).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);
  await db.session.deleteMany({ where: { shop } });
  await db.shop.deleteMany({ where: { shop } });
  await db.job.deleteMany({ where: { shop } });
  await db.chartVersion.deleteMany({ where: { shop } });
  await db.event.deleteMany({ where: { shop } });
  console.log(
    JSON.stringify({
      level: "info",
      msg: "Shop data erased",
      shop,
      route: "webhooks/shop/redact",
    }),
  );
  return new Response();
};
