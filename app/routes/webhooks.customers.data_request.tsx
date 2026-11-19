import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// A shopper asked the store for their data. Fitted stores no shopper data
// (ARCHITECTURE §14), so there is nothing to send. The payload names the
// shopper, so it is never logged.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);
  console.log(
    JSON.stringify({
      level: "info",
      msg: "Customer data request acknowledged: no shopper data stored",
      shop,
      route: "webhooks/customers/data_request",
    }),
  );
  return new Response();
};
