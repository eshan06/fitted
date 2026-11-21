// The shell's follow-up for a plan check that outlasted the stream (app.tsx,
// ARCHITECTURE §8): it waits for the check and answers with the plan. A
// resource route: the parent's loader doesn't run, so this one authenticates
// (§3).
import type { LoaderFunctionArgs } from "react-router";
import { getPlan } from "../models/billing.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return getPlan(session.shop); // never rejects
};
