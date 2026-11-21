import { useRevalidator } from "react-router";

// The staff-without-access message (Fitted canvas, Dashboard board). Every
// screen shows it under its own title when Shopify refuses this staff member
// a read (ARCHITECTURE §15). Try again works once the owner adds access.
const HEADING = "You need Products access";
const BODY =
  "Fitted can't show this page without it. Ask the store owner to add it to your account in Settings › Users.";

/** A load's answer for it: the 403 of §15, or a stream's settled value. */
export const NO_ACCESS = { code: "access", message: `${HEADING}. ${BODY}` };

export function NoAccess() {
  const { revalidate, state } = useRevalidator();
  return (
    <s-banner tone="critical" heading={HEADING}>
      <s-paragraph>{BODY}</s-paragraph>
      <s-button
        slot="secondary-actions"
        // React 18 writes `false` as the string "false", which still counts as set.
        {...(state === "loading" && { loading: true })}
        onClick={() => revalidate()}
      >
        Try again
      </s-button>
    </s-banner>
  );
}
