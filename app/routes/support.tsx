import type { MetaFunction } from "react-router";
import { PublicPage } from "../components/public-page";

// Fitted's support page, public and without a session. Bracketed words are for
// the owner to fill in (#48).
export const meta: MetaFunction = () => [
  { title: "Support · Fitted" },
  {
    name: "description",
    content: "Get help with the Fitted size chart app for Shopify.",
  },
];

export default function Support() {
  return (
    <PublicPage>
      <h1>Fitted support</h1>
      <p>
        Fitted adds size charts and a size recommender to your Shopify store. If
        something isn&rsquo;t working or you have a question, we&rsquo;re here
        to help.
      </p>

      <h2>Contact us</h2>
      <p>
        Email <strong>[SUPPORT EMAIL]</strong>. We reply within [RESPONSE TIME].
      </p>
      <p>
        Tell us your store&rsquo;s <code>myshopify.com</code> address and what
        you were doing when the problem happened. A screenshot helps. Never send
        us a password.
      </p>

      <h2>Common questions</h2>
      <h3>My size guide doesn&rsquo;t show on a product</h3>
      <ul>
        <li>
          Check that the Fitted size guide is turned on in your theme: in
          Shopify, go to Online Store, Themes, Customize, then App embeds.
        </li>
        <li>
          Check that the chart is published. Drafts never show to shoppers.
        </li>
        <li>
          Check that a display rule on Fitted&rsquo;s Display rules screen gives
          that product the chart.
        </li>
      </ul>
      <h3>Can I move my charts from Kiwi Size Chart?</h3>
      <p>
        Yes, free on every plan. Open Import in Fitted and choose Kiwi. If
        Fitted can&rsquo;t read your Kiwi charts, you can import them from a CSV
        file or a picture of the chart instead. Imported charts start as drafts,
        so nothing changes for shoppers until you publish.
      </p>
      <h3>Can I take my charts with me?</h3>
      <p>Yes. Export every chart as a CSV file from Fitted on any plan.</p>
      <h3>What happens if I uninstall?</h3>
      <p>
        Shopify removes Fitted&rsquo;s data from your store when you uninstall,
        including your charts. Export them as CSV first if you want to keep
        them.
      </p>
      <h3>How do I change my plan?</h3>
      <p>
        Plans are billed by Shopify, on your Shopify bill. Open Fitted in your
        Shopify admin to see your plan and change it. Uninstalling Fitted ends a
        paid plan.
      </p>

      <footer>
        <a href="/privacy">Privacy policy</a>
      </footer>
    </PublicPage>
  );
}
