import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// The store asked for a shopper's data to be erased. Fitted stores no shopper
// data (ARCHITECTURE §14), so there is nothing to delete. The payload names the
// shopper, so it is never logged.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);
  console.log(
    JSON.stringify({
      level: "info",
      msg: "Customer redact request acknowledged: no shopper data stored",
      shop,
      route: "webhooks/customers/redact",
    }),
  );
  return new Response();
};
