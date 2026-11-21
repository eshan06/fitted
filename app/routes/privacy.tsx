import type { MetaFunction } from "react-router";
import { PublicPage } from "../components/public-page";

// Fitted's privacy policy, public and without a session. It must match what the
// app stores and sends (ARCHITECTURE §4, §10, §12, §13, §14): a change there
// changes this page. Bracketed words are for the owner to fill in (#48).
export const meta: MetaFunction = () => [
  { title: "Privacy policy · Fitted" },
  {
    name: "description",
    content: "What the Fitted Shopify app stores, sends and keeps.",
  },
];

export default function Privacy() {
  return (
    <PublicPage>
      <h1>Fitted privacy policy</h1>
      <p>Last updated: [EFFECTIVE DATE]</p>
      <p>
        Fitted is a Shopify app that adds size charts and a size recommender
        (the fit finder) to clothing stores. It is made by [LEGAL NAME]
        (&ldquo;we&rdquo;). This policy says what Fitted collects when a
        merchant installs it, why, who else sees it, how long we keep it, and
        how to reach us.
      </p>

      <h2>The short version</h2>
      <ul>
        <li>
          Your live charts, display rules and settings are saved in your own
          Shopify store. We keep a copy of each saved chart version, for
          history.
        </li>
        <li>
          Fitted collects no personal data about your shoppers. Fit finder
          answers stay in the shopper&rsquo;s browser.
        </li>
        <li>
          We keep what we need to run the app: your store&rsquo;s sign-in with
          Shopify, your plan, chart history and size guide counts.
        </li>
        <li>
          We don&rsquo;t sell data or use it for advertising. Files you upload
          to import a chart are read once and never stored by Fitted.
        </li>
      </ul>

      <h2>What Fitted collects about merchants</h2>
      <h3>Your store</h3>
      <p>
        When you install Fitted, Shopify gives us your store&rsquo;s{" "}
        <code>myshopify.com</code> address, an access token that lets Fitted
        work in your store, and the permissions you granted. We also record
        which Fitted plan your store is on and whether it is billed monthly or
        yearly, both read from Shopify.
      </p>
      <h3>Your staff</h3>
      <p>
        When someone on your staff opens Fitted, Shopify sends us their Shopify
        user ID, first and last name, email address, language, and whether they
        own the store. We keep these with their sign-in session. Each saved
        chart version also keeps the first name and last initial of the staff
        member who saved it, which chart history shows.
      </p>
      <h3>What you make in Fitted</h3>
      <p>
        Charts, display rules, appearance and fit finder settings and custom
        text are saved in your Shopify store as app data. To show version
        history, we also keep a copy of each saved version of a chart in our
        database, with who saved it.
      </p>
      <h3>Size guide counts</h3>
      <p>
        When a shopper opens the size guide, gets a fit finder result or adds a
        size to the cart from the guide, the guide sends us an event: what
        happened, which chart and product, the size recommended or added, and
        when. We use these for the counts on Fitted&rsquo;s Home screen.
      </p>
      <h3>Imports</h3>
      <p>
        When you import charts, we keep the import&rsquo;s progress and result.
        A CSV, image, PDF or document you upload is read in memory and never
        stored. To find charts from Kiwi Size Chart, Fitted reads your
        store&rsquo;s public product pages; to import from your product
        descriptions it reads those; to import from a web page it reads the link
        you paste. We also keep a daily count of how often your store used
        OpenAI, for imports and translations, to keep within limits.
      </p>
      <h3>Logs</h3>
      <p>
        Our server writes technical logs that name your store, so we can find
        and fix problems. They never hold access tokens, staff names or emails,
        uploaded files or shopper data. Railway, which hosts Fitted, may keep
        its own standard request logs under its own policy.
      </p>

      <h2>What Fitted reads in your Shopify store</h2>
      <p>
        To show the right chart on each product, Fitted reads your products and
        the facts your display rules use: tags, product type, vendor,
        collections and the product fields a rule names. It also reads your
        store&rsquo;s languages. Fitted has no access to your orders or your
        customer records.
      </p>

      <h2>Your shoppers</h2>
      <ul>
        <li>
          Fitted stores no personal data about shoppers. It never saves a
          customer ID, IP address or device details with an event. A
          shopper&rsquo;s IP address is used for a moment, in memory, to stop
          floods of fake events, and is never saved.
        </li>
        <li>
          Fit finder answers, such as measurements, usual size or preferred fit,
          are never sent to us or anyone else. They stay in the shopper&rsquo;s
          browser for that tab and are gone when the tab closes. Like anything
          on a web page, other scripts running on your store could read them
          while the page is open.
        </li>
        <li>
          If your store uses Google Analytics, the size guide also reports size
          guide opens, fit finder results and add-to-cart clicks to your own
          Google Analytics, with only the chart&rsquo;s code name. Your Google
          Analytics and consent settings apply, and we don&rsquo;t receive that
          data.
        </li>
        <li>Fitted sets no advertising or tracking cookies.</li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To run Fitted for your store and show your charts to shoppers.</li>
        <li>
          To show who changed a chart, and to let you restore old versions.
        </li>
        <li>To apply your plan&rsquo;s features and limits.</li>
        <li>To show you how often your size guide is used.</li>
        <li>To answer support requests and keep the app secure.</li>
      </ul>
      <p>
        We don&rsquo;t sell data, use it for advertising, or share it with
        anyone except the services below.
      </p>

      <h2>Who else handles it</h2>
      <ul>
        <li>
          <strong>Shopify</strong> runs your store and sends us the data above.
          See{" "}
          <a href="https://www.shopify.com/legal/privacy">
            Shopify&rsquo;s privacy policy
          </a>
          .
        </li>
        <li>
          <strong>Railway</strong> hosts Fitted&rsquo;s server and database.
        </li>
        <li>
          <strong>OpenAI</strong> reads a chart for us when you import from an
          image or PDF: we send it the file&rsquo;s contents. If you use
          Translate, we send it your charts&rsquo; words and your size
          guide&rsquo;s custom text to translate. Nothing else goes to OpenAI,
          and never shopper data. OpenAI handles it under its{" "}
          <a href="https://openai.com/policies/">API terms and policies</a>.
        </li>
      </ul>
      <p>We may also disclose data when the law requires it.</p>

      <h2>Where it is processed</h2>
      <p>
        Fitted&rsquo;s server and database run in [HOSTING REGION]. Shopify and
        OpenAI may process data in other countries under their own policies.
      </p>

      <h2>How long we keep it</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Data</th>
              <th scope="col">Kept</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Your store&rsquo;s sign-in and access token</td>
              <td>Until you uninstall Fitted</td>
            </tr>
            <tr>
              <td>Your store&rsquo;s plan record</td>
              <td>Until about 48 hours after you uninstall</td>
            </tr>
            <tr>
              <td>Staff sign-in sessions (name and email)</td>
              <td>
                Until the session expires; expired ones are deleted the next
                time someone from your store signs in, and all are deleted when
                you uninstall
              </td>
            </tr>
            <tr>
              <td>Chart version history, with who saved each version</td>
              <td>The last 30 versions of each chart</td>
            </tr>
            <tr>
              <td>Size guide events</td>
              <td>90 days</td>
            </tr>
            <tr>
              <td>Daily OpenAI use counts</td>
              <td>30 days</td>
            </tr>
            <tr>
              <td>Import and display rule jobs</td>
              <td>The latest of each kind; older ones for 7 days</td>
            </tr>
            <tr>
              <td>Files you upload to import</td>
              <td>Not stored</td>
            </tr>
            <tr>
              <td>Server logs</td>
              <td>[LOG RETENTION]</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>When you uninstall</h2>
      <p>
        When you uninstall Fitted, we delete your store&rsquo;s sign-in sessions
        straight away and reset your plan to Free. About 48 hours later Shopify
        asks us to erase your store&rsquo;s data, and we delete everything we
        hold for your store. Shopify also removes Fitted&rsquo;s app data,
        including your charts, from your store, so export your charts as CSV
        first if you want to keep them. Export is free on every plan. Images and
        fonts you uploaded through Fitted stay in your store&rsquo;s Files until
        you delete them.
      </p>

      <h2>How we protect it</h2>
      <p>
        Fitted is served only over HTTPS. Every request from Shopify is checked
        for Shopify&rsquo;s signature, and Fitted only ever reads or changes
        data for the store that is signed in. Access tokens never appear in our
        logs.
      </p>

      <h2>Your choices and rights</h2>
      <p>
        Merchants can export their charts as CSV at any time, and can ask us for
        a copy of the data we hold about their store or staff, or ask us to
        correct or delete it, by emailing [SUPPORT EMAIL]. Depending on where
        you live, laws such as the GDPR or the CCPA may give you further rights,
        and you may complain to your data protection authority.
      </p>
      <p>
        Shoppers: Fitted holds no personal data about you. For your data in a
        store, contact that store. When a store passes on a shopper&rsquo;s data
        request through Shopify, we answer it, and we have nothing to return or
        delete.
      </p>

      <h2>Children</h2>
      <p>
        Fitted is a tool for businesses and is not meant for children. We
        don&rsquo;t knowingly collect data about children.
      </p>

      <h2>Changes to this policy</h2>
      <p>
        If we change this policy, we&rsquo;ll post the new version here and
        update the date at the top.
      </p>

      <h2>Contact us</h2>
      <p>
        [LEGAL NAME]
        <br />
        [CONTACT ADDRESS]
        <br />
        Email: [SUPPORT EMAIL]
      </p>

      <footer>
        <a href="/support">Fitted support</a>
      </footer>
    </PublicPage>
  );
}
