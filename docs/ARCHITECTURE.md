# Architecture

The design every step builds against. Read this index, then only the sections your work touches, and cite them by number ("ARCHITECTURE §5"). A section marked "confirm in #n" names a detail that step checks on the dev store and then records here. Past about 5,000 words, split into docs/arch/<area>.md.

1. Stack: Shopify's React Router app template, TypeScript, Node 22, npm.
2. Admin app: the embedded screens and their routes.
3. Auth and sessions: `app/shopify.server.ts`, scopes, staff names.
4. Where data lives: the merchant's store, the app database, and what uninstalling does.
5. Size chart: the `$app:chart` metaobject and its JSON.
6. Display rules: how a product finds its chart.
7. Settings and plan metafields: what the storefront reads besides charts.
8. Plans and gating: Free, Standard, Pro, read from the Partner API.
9. Storefront: the theme app extension.
10. Fit finder: the shared engine; measurements stay in the browser.
11. Translations: how chart words reach every store language.
12. Events and stats: the app proxy endpoint.
13. Import: sources, drafts, jobs, OpenAI, fetch safety.
14. App database: Postgres tables on Railway.
15. Errors and retries: the conventions every route follows.
16. Webhooks: every subscription and its handler.
17. Hosting and environment: Railway and env vars.
18. Pipeline: CI, review and size gates in `.github/`, agent rules in `.claude/`.

## 1. Stack

Scaffolded from Shopify's React Router template (commit 9597d08): React Router 7 with Vite, `@shopify/shopify-app-react-router`, App Bridge, Polaris web components, Prisma. Tests run on Vitest (`app/**/*.test.ts(x)`). `shopify.app.toml` holds the app's Shopify config (client ID, scopes, webhooks, metafield and metaobject definitions, app proxy); `shopify.web.toml` tells the Shopify CLI how to run it. Server-only modules end in `.server.ts` and live in `app/models/`; code shared with the storefront lives in `app/lib/` and imports nothing from server code (§9).

## 2. Admin app

`app/routes/app.tsx` authenticates every admin request (`authenticate.admin`) and renders the App Bridge shell with Fitted's navigation, in this order: Home (`app._index.tsx`), Size charts (`app.charts._index.tsx`, with `app.charts.new.tsx` for the template picker and `app.charts.$id.tsx` for the editor), Import (`app.import.tsx`), Display rules (`app.rules.tsx`), Fit finder (`app.fit-finder.tsx`), Appearance & languages (`app.appearance.tsx`). CSV export is `app.export.tsx`.

Screens read and write through `app/models/*.server.ts` (charts, rules, settings, billing, stats, imports), never with GraphQL inline in a route. Whether the size guide's app embed is on (Home's setup guide) comes from App Bridge `shopify.app.extensions()` in the browser, which needs no extra scope.

## 3. Auth and sessions

`app/shopify.server.ts` configures `shopifyApp`: Admin API version July 2026, App Store distribution, expiring offline tokens, and `PrismaSessionStorage`. OAuth runs through `app/routes/auth.$.tsx`. Every loader and action that touches shop data calls `authenticate.admin` (or `authenticate.webhook` / `authenticate.public.appProxy`) and uses only that session's shop. Background work (webhooks, jobs) uses `unauthenticated.admin(shop)` with the shop from a verified webhook or from the job row, never from a browser.

Staff names: the charts list and version history show who saved ("Priya N."). The first step that records an editor (#24) turns on `useOnlineTokens: true`; `session.onlineAccessInfo.associated_user` then gives the name, and Fitted stores only first name plus last initial. Offline tokens keep serving background work.

Scopes, added by the step that first needs each: `write_products`, `write_metaobjects`, `write_metaobject_definitions` (already set), `write_translations` and `read_locales` (#43), `write_files` (#22, How to measure images), `write_app_proxy` (#44). Nothing else without updating this list.

## 4. Where data lives

| Data                                                            | Where                                 | Section |
| --------------------------------------------------------------- | ------------------------------------- | ------- |
| Charts                                                          | Metaobjects of type `$app:chart`      | §5      |
| Which chart a product shows                                     | Product metafield `$app.chart`        | §6      |
| Display rules                                                   | Shop metafield `$app.rules` (json)    | §6      |
| Appearance, units, placement, fit finder settings, custom texts | Shop metafield `$app.settings` (json) | §7      |
| The plan, for the storefront                                    | Shop metafield `$app.plan`            | §7      |
| How to measure images, uploaded fonts                           | Shopify Files                         | §5, §7  |
| Sessions, plan cache, versions, jobs, events, AI usage          | Postgres                              | §14     |

All definitions are app-owned and declared in `shopify.app.toml` (`[metaobjects.app.chart]`, `[product.metafields.app.chart]`, `[shop.metafields.app.settings]`, and so on); code reads them as type `$app:chart` and namespace `$app`, never `app`. Admin access stays `merchant_read`: merchants can see everything in their Shopify admin, but only Fitted writes, so every write passes Fitted's validation and no other app or staff edit can inject into the storefront.

Uninstalling: Shopify deletes app-owned definitions at uninstall and keeps the values only temporarily, with no guaranteed period. So charts live in the merchant's store while Fitted is installed, and CSV export on every plan (#33) is the way to take them elsewhere. Copy must not promise that charts outlive an uninstall. Reinstalling before Shopify's cleanup brings them back.

## 5. Size chart

One metaobject per chart, type `$app:chart`, defined in `shopify.app.toml`:

- `access.admin = "merchant_read"`, `access.storefront = "public_read"` (Liquid needs it).
- `capabilities.publishable = true`: status `ACTIVE` is what the screens call Published or Active; `DRAFT` is Draft. Drafts never reach shoppers. Imports and new charts start as Draft.
- `capabilities.translatable = true` (§11).
- Handle: `c-` plus 10 random `[a-z0-9]`, set at create, never changed, never shown. Writes use `metaobjectUpsert` with that handle, so a retried save or import never duplicates a chart.

| Field           | Type                                      | Holds                                                                                                                                                                |
| --------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | single_line_text_field, required          | Admin name, at most 100 characters; `display_name_field`. Not shown to shoppers.                                                                                     |
| `template`      | single_line_text_field, required, choices | `blank`, `tops`, `bottoms`, `dresses`, `bras_swimwear`, `shoes`, `kids`, `headwear`, `rings`, `bracelets`, `necklaces`. Picks the garment drawing in the size guide. |
| `content`       | json, required                            | Structure, numbers and the source words (below). Never translated.                                                                                                   |
| `strings`       | json, required                            | The same map as `content.words`. The one field translations are registered on (§11).                                                                                 |
| `measure_image` | file_reference                            | Optional How to measure image (PNG or JPG).                                                                                                                          |
| `import_note`   | single_line_text_field                    | Admin-only note an import leaves ("Check units"); cleared by the next save from the editor.                                                                          |

`content`, version 1:

```ts
type Content = {
  v: 1;
  unit: "in" | "cm"; // the unit the merchant types in
  roundTo: 0.25 | 0.5 | 1; // rounding for converted values
  tables: Table[]; // 1 to 4, shown in order under their own headings
  measure: { steps: string[] }; // step ids in order; step n is line n on the drawing
  videoUrl?: string; // https YouTube or Vimeo link only
  fit?: Fit; // §10
  words: Record<string, string>; // every word a shopper sees, by key
};
type Table = {
  id: string;
  columns: Column[]; // 1 to 20; the first is the one "size" column
  rows: { id: string; cells: Record<string, [number] | [number, number]> }[]; // 1 to 60
  merges?: { row: string; col: string; rows: number; cols: number }[];
  wrap?: string[]; // ids of columns whose text wraps
};
type Column =
  | { id: string; kind: "size" | "text" }
  | { id: string; kind: "country"; country: "US" | "UK" | "EU" | "AU" }
  | {
      id: string;
      kind: "measure";
      unit?: "in" | "cm" | "lb" | "kg";
      convert: boolean;
    };
```

Numbers in `content`, words in `words`: a row's `cells` hold only measure columns, as `[value]` or `[min, max]` in the column's unit (`unit` or the chart's), each above 0 and below 10,000, min at most max; an empty cell is a missing key. Every text is a `words` entry: `<table>.title`, `<table>.sub`, `<table>.note`, `<table>.<col>` (column label), `<table>.<row>.<col>` (size, country and text cells), `m.<step>.name`, `m.<step>.text`, `tips`, and the fit finder's `fit.<question>` and `fit.<question>.<option>`. Words are plain text, rendered escaped (never HTML), at most 500 characters each, `tips` at most 2,000. Ids match `[a-z0-9]{1,8}` and are unique within the chart. Cells covered by a merge, other than its top-left cell, are ignored. `convert: false` keeps a column as typed for shoppers. Country columns show one at a time behind a US/UK/EU/AU switch when a table has two or more. `content` stays under 100 KB (Shopify caps json at 128 KB).

`app/models/chart.server.ts` (#15) owns the definition's reads and writes and one validator that every write goes through: the editor, imports, restores, templates and duplicates. Invalid input is refused with a field path and a plain message. A chart that fails validation when read shows as an error on that chart; it is never dropped silently. It writes `strings` equal to `content.words` on every save. Templates (#25) live in `app/data/templates/` and set columns, size rows, measure steps and words, never numbers.

Free plan: at most 3 Active charts; drafts are unlimited (§8).

Version history (#24) is in Postgres (§14): each successful save, restore, import or template creation adds a `ChartVersion` row holding the saved fields, who saved it, and a one-line summary of what changed. The newest row is the current version; restoring saves an old snapshot as a new version, so nothing is lost. Fitted keeps the last 30 versions per chart (the canvas's [VERSION LIMIT]; the owner can change the number). If the Shopify write fails, no version is recorded; if only the version write fails, the merchant is told the chart saved but history missed that save.

Concurrent edits: a save sends the `updatedAt` the editor loaded; if the chart changed since, the save is refused with "This chart changed since you opened it" and a reload, never a silent overwrite.

Copy link (#24) gives `https://<shop>/apps/fitted/charts/<handle>`, an app proxy page (`app/routes/proxy.charts.$handle.tsx`) rendering the Active chart in the store's theme layout, 404 for drafts. The canvas doesn't draw this page yet, so it gets drawn first.

## 6. Display rules

Rules live in one shop metafield, `$app.rules` (json, at most 100 KB):

```ts
type Rules = {
  v: 1;
  order: string[]; // chart GIDs, highest priority first
  charts: Record<
    string,
    { match: Condition[]; exclude: Condition[]; auto: boolean }
  >;
};
type Condition =
  | { field: "all" } // the "Store default: Everything else" entry
  | { field: "product" | "collection"; op: "is" | "is_not"; ids: string[] }
  | {
      field: "tag" | "type" | "vendor";
      op: "is" | "is_not" | "contains";
      value: string;
    }
  | {
      field: "metafield";
      key: string;
      op: "is" | "is_not" | "contains";
      value: string;
    };
```

A chart matches a product when any `match` condition holds and no `exclude` condition does. Text compares are trimmed and case-insensitive; `contains` is a substring test; tags compare one tag at a time; `key` is `namespace.key`. Across charts, the first chart in `order` that matches and is Active wins; a Draft chart is skipped, so its products fall through to the next match. At most 1,000 product and collection ids across all rules; past that the save is refused with a suggestion to use a tag or collection.

Resolution is a pure function, `resolveChart(product, rules, activeChartIds)`, returning a chart GID or null, where `product` is `{ id, tags, productType, vendor, collectionIds, metafields }`. Its result is written to the product metafield `$app.chart` (`metaobject_reference<$app:chart>`, `merchant_read`, `capabilities.admin_filterable = true`), only when it differs from the current value; null deletes the metafield. Only the resolver writes it. Comparing before writing also stops our own metafield write from looping through `products/update`.

When it runs (#26):

- Full resolve, as a `resolve` job (§13): after a rules save, after a chart is published, unpublished or deleted, and from the Home loader when the shop's last full resolve is over 24 hours old (this catches missed webhooks without a scheduler). A bulk query reads every product's facts and current chart; the changes go out in a bulk mutation of `metafieldsSet` calls, 25 metafields per line, and deletes for unassigned products (confirm the delete path in #26).
- One product: `products/create` and `products/update` resolve that product. Charts with `auto: false` are applied only by full resolves; a webhook never assigns or removes them.
- `collections/update` re-resolves that collection's products when a rule names the collection.

Counts: "Shown on 148 products" and "Products with a chart: 312 of 340" are `productsCount` queries on the metafield (`metafields.$app.chart:"<gid>"`, and `-metafields.$app.chart:*` for products without one); confirm the namespace form in #26, else use the resolved `app--<app id>` namespace.

Free plan: rules use only `all`, `product` and `collection` conditions; Standard and Pro use every field. Rules saved on a paid plan keep resolving after a downgrade; they just can't be edited into new paid conditions.

## 7. Settings and plan metafields

`$app.settings` is a shop metafield (json, `merchant_read`), written whole by the Appearance and Fit finder screens through `app/models/settings.server.ts`, which validates it and fills defaults on read:

```ts
type Settings = {
  v: 1;
  link: {
    style: "text" | "button" | "tab";
    icon: "ruler" | "hanger" | "tape" | "none";
  };
  popup: {
    style: "center" | "drawer";
    sheetOnPhone: boolean;
    openFrom: "bottom" | "right" | "fade";
    font: "theme" | { fileUrl: string };
    logo: boolean;
    sticky: boolean;
    rtl: boolean;
    fitOnly: boolean;
  };
  placement: {
    productBlock: boolean;
    quickView: boolean;
    floatingTab: boolean;
    featured: boolean;
    selector: string;
  };
  colors:
    | { mode: "theme" }
    | { mode: "custom"; text: string; accent: string; background: string };
  units: { default: "country" | "in" | "cm"; toggle: boolean };
  css: string; // at most 10 KB, refused if it contains "<"
  fitFinder: {
    type: "basic" | "advanced" | "custom";
    answers: "inputs" | "sliders";
    fitBars: boolean;
    otherSizes: boolean;
    addToCart: boolean;
    onButton: boolean;
    similar: boolean;
    note: boolean;
    askAge: boolean;
  };
  text: Record<string, { label: string; header: string; noFit: string }>; // by locale; the primary locale is required
};
```

Colors are `#rrggbb`. `selector` is at most 200 characters and only used in `querySelector`. `text` is Fitted-managed per locale (§11) and falls back to the primary locale.

`$app.plan` is a shop metafield (single_line_text_field, choices `free`, `standard`, `pro`), written only by the billing module after a confirmed plan read (§8). The storefront reads it to show or hide Pro features.

Liquid reads app-owned metafields whatever their storefront access, so none of these need `public_read`. Liquid prints `css` into the page, which is why only Fitted may write it (§4).

## 8. Plans and gating

Fitted bills through Shopify App Pricing: plans are set up in the Partner Dashboard (#49) with handles `free`, `standard` and `pro`, monthly and yearly. The app never creates charges. The active plan comes from the Partner API's `activeSubscription(appId, shopId)` (its `items[].handle`), not the Admin API, and App Pricing sends no webhooks. `app/models/billing.server.ts` (#17):

- Caches the confirmed plan on the `Shop` row and re-checks when it is over 5 minutes old, on the next admin load. The welcome link after a plan change carries `plan_handle`; the app re-checks at once.
- If the Partner API fails, it uses the last confirmed plan whatever its age and shows a banner if that's over a day old; with none ever confirmed, Free with a banner. A failed check never downgrades the storefront: `$app.plan` changes only on a confirmed read.
- A missing subscription or an unknown handle is Free.
- A cancellation that happens outside the app is seen on the next admin load (Shopify gives no webhook); until then the storefront keeps the last plan.

| Gate                                              | Free                     | Standard  | Pro       |
| ------------------------------------------------- | ------------------------ | --------- | --------- |
| Active charts                                     | 3                        | unlimited | unlimited |
| Rule fields (§6)                                  | all, product, collection | all       | all       |
| Fit finder on the storefront (§10)                | no                       | no        | yes       |
| Fitted's translation tools (§11)                  | no                       | no        | yes       |
| Fit finder results in stats (§12)                 | no                       | no        | yes       |
| Imports, CSV export, appearance, Home opens stats | yes                      | yes       | yes       |

Every gate is a function in the billing module with a test. Gates block new actions and never destroy data: after a downgrade, live charts beyond 3 stay live and translations stay up, but nothing new is published or translated past the plan. Merchants can set up the fit finder on any plan; it goes live on Pro, as the canvas shows.

## 9. Storefront

The size guide is one theme app extension, `extensions/size-guide/`:

- App block `blocks/size-guide.liquid` for the product page next to the size picker. Themes that render app blocks in their quick view and featured product sections show it there too (#32 confirms on the dev store's theme).
- App embed `blocks/embed.liquid` for the floating tab and the CSS-selector placement, on product pages only, per `settings.placement`.
- A snippet prints the data once per product as `<script type="application/json" data-fitted>`: the chart's `content` and `strings` (Liquid gives the shopper's locale), the image URL, the settings the guide uses, the plan, and the locale.

Liquid reads `product.metafields["$app"].chart.value`, `shop.metafields["$app"].settings.value` and `shop.metafields["$app"].plan.value`; the `$app` prefix resolves only inside the extension. No chart (the metafield is empty, the chart is Draft, or its data doesn't parse) means nothing renders: no link, no tab.

Data is inline, so opening the guide makes no request. JavaScript: `assets/loader.js`, at most 10 KB compressed (Shopify's suggested limit), renders the link and loads `assets/guide.js` with `import()` on first open. The canvas's loading state shows while that import runs; its error state, with Try again, shows if it fails. Liquid stays under the extension's 100 KB limit.

Shared code: storefront logic is written in `app/lib/` (the guide renderer and `fit-finder.ts`), with no dependencies and no React, and built into `extensions/size-guide/assets/` by an npm script. The built files are committed, and a test fails when they differ from a fresh build. The admin live preview (#23) renders with the same module, so it matches the storefront.

Units: `settings.units.default` of `country` shows inches when `localization.country.iso_code` is US, LR or MM, centimeters elsewhere. Conversion uses 2.54 cm per inch and 0.4536 kg per pound, rounded to `content.roundTo`. Classes are prefixed `fitted-`; custom CSS is printed in one `<style>`; colors and fonts follow the theme unless `colors.mode` is custom. `popup.rtl` sets `dir="rtl"` on the popup. Fit videos are embedded from the video id that Fitted parses out of the link, never from the raw URL.

## 10. Fit finder

`app/lib/fit-finder.ts` (#40) is a pure function the storefront and the admin preview share: given a chart's table, the answers, and the chart's fit settings, it returns the recommended size row (or none), a reason as a words key with values, and fit bars (0 to 100, tight to loose) for every size and measured column. A chart's fit settings sit in `content.fit`:

```ts
type Fit = {
  table: string; // the table it recommends from
  questions: Question[]; // asked in order, 1 to 6
  ease: Record<string, number>; // per measure column, in that column's unit
  stretch: "none" | "some" | "high";
};
type Question =
  | { id: string; kind: "measure"; col: string; optional: boolean }
  | { id: string; kind: "usual_size" } // choice of the table's size rows
  | { id: string; kind: "fit" } // snug, regular, relaxed
  | { id: string; kind: "choice"; options: { id: string; rows: string[] }[] }; // each answer narrows the sizes
```

Question texts are `words` keys (§5). #40 may add question kinds (age, for the Basic type); it records them here.

Measurements never leave the browser: no request carries an answer, nothing is stored on a server, and answers sit only in `sessionStorage` (`fitted:answers`) so the next product can reuse them until the tab closes. Events (§12) carry only the recommended size label. The storefront shows Find my size only when `$app.plan` is `pro` and the chart has `fit`.

## 11. Translations

Chart words: `strings` is the only chart field Fitted translates. Translations are registered with `translationsRegister` on the chart metaobject, using the digest from `translatableResourcesByIds`, and Liquid renders each shopper's language. The storefront merges `{ ...content.words, ...strings }`, so an untranslated word shows in the primary language, and numbers never go stale because no translated field holds them. When a merchant edits a chart, Shopify marks that chart's translations outdated. Each save removes translations any app registered on other fields (`content`, `name`).

Translate all charts (#43, Pro) fills missing and outdated locales through OpenAI (§13), word by word, keeping the keys. Per store language (`shopLocales`), the Appearance screen shows: the primary locale as Published; Translated when every Active chart has a current translation; Needs review when any is outdated; otherwise Not translated. The canvas's Review button opens a screen the canvas doesn't draw yet, so #43 gets it drawn first.

Settings words (`settings.text`) are kept per locale by Fitted and filled by the same Translate action. The guide's own interface words (tab names, Tight to Loose, buttons) are the extension's `locales/*.json` files, and languages Fitted doesn't ship fall back to English.

## 12. Events and stats

Shoppers' browsers post events to the app proxy: `shopify.app.toml` sets `[app_proxy]` with prefix `apps` and subpath `fitted`, and `POST /apps/fitted/events` reaches `app/routes/proxy.events.tsx` (#44).

- Body: JSON text of at most 1 KB, sent with `navigator.sendBeacon`: `{ id, type, chart, product, size? }`, where `id` is a UUID v4, `type` is `open`, `fit_result` or `add_to_cart`, `chart` and `product` are GIDs, and `size` is a size label of at most 20 characters. Unknown keys are refused.
- Verify: `authenticate.public.appProxy` checks the signature; a `timestamp` over 5 minutes old is refused; the shop comes only from the verified request.
- No shopper data: `logged_in_customer_id`, the IP address and the user agent are never stored. The client IP (`X-Forwarded-For`) is used only in memory, for rate limiting: 30 events a minute per IP and shop, and 20,000 a day per shop.
- Replay: a repeated `(shop, id)` returns success without a second row.
- Responses: 204 recorded or duplicate, 400 bad input, 401 bad signature or stale timestamp, 429 over the limit. The storefront never retries an event or shows its failure.

Rows go to the `Event` table (§14) and are deleted after 90 days. Home (#45) shows opens in the last 30 days, the most opened chart and opens per chart on every plan; fit finder results on Pro. When the store has `window.gtag`, the storefront also sends `fitted_open`, `fitted_fit_result` and `fitted_add_to_cart` through it, so the store's own GA and consent setup apply; Fitted stores no GA ids.

## 13. Import

Every source produces the same `ChartDraft`: a chart's `name`, `template` and `content` (§5), plus the products it was on, a status of `ready`, `check_units` or `unreadable`, and a plain reason for anything not ready. Drafts go through the chart validator like any other write.

| Source               | Step     | Reads                                           |
| -------------------- | -------- | ----------------------------------------------- |
| Kiwi Size Chart      | #35, #36 | The session shop's own storefront product pages |
| CSV                  | #33      | Fitted's CSV template or a spreadsheet export   |
| Product descriptions | #37      | `descriptionHtml` from the Admin API            |
| Image, PDF           | #38      | An upload, read by OpenAI                       |
| Web page, Word       | #39      | A pasted link, or a .docx upload                |

Flow (#34): Find charts starts an `import` job (below). The review screen lists the drafts; Fix resolves `check_units`; Import creates the selected drafts as Draft charts with handles derived from the job and draft index, so Try again re-runs only the failed ones and never duplicates. Their product assignments become `product` conditions (§6). Nothing goes live until the merchant publishes. A version row records "Imported from Kiwi" or the source.

Jobs: imports and full rule resolves run as `Job` rows (§14) inside the app process: at most one running job per shop and kind; progress saved as it goes, so a stopped scan offers the charts found so far; a job with no progress for 10 minutes, or one still running when the server starts, is marked failed so the merchant can scan again. The newest finished job per shop and kind is kept (Home's setup guide reads it); others go after 7 days. `ponytail:` in-process jobs assume one Railway instance; move to a queue before running two.

Limits and safety:

- Uploads: CSV up to 1 MB, images (PNG, JPG, WebP) up to 10 MB, PDFs up to 20 MB, .docx up to 5 MB. The type is checked by the file's first bytes, not its name. Files are processed in memory and never stored.
- Kiwi (#6 limits): only after the merchant clicks Find charts; only `https://<session shop>` pages; at most 2 requests a second with a 10-second timeout each; numbers and text only, no Kiwi images, logos or styling. A shop without Kiwi, or with a password-protected storefront, gets the "nothing found" state with its reason. Re-check Kiwi's terms before launch.
- Web links (#39): http and https only; every address the host resolves to, and every redirect, is refused when private, loopback, link-local or a metadata address; 10-second timeout, 5 MB cap.
- OpenAI: image and PDF import and translations go through one module, `app/models/openai.server.ts`, with `OPENAI_API_KEY`, the model name in one constant, structured JSON output, and a 60-second timeout. The model's answer is untrusted input: it is validated like any draft. Each shop gets 50 OpenAI calls a day (`AiUsage`, §14); past that, or when OpenAI refuses for quota (the organization has a hard $5 monthly cap for now), the merchant is told plainly and offered CSV.

CSV (#33): one row per size row; #33 records the exact columns here. Export covers every chart on every plan; sizes, columns, values, units and notes survive a round trip unchanged, and a bad file gets row-level errors.

## 14. App database

Postgres on Railway (#8, `DATABASE_URL`), a local Postgres for development (#14), Prisma migrations applied by `npm run setup` (`prisma migrate deploy`). Each table arrives with the first step that needs it.

| Table          | Holds                                                                                                                     | Step     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | -------- |
| `Session`      | The template's sessions                                                                                                   | exists   |
| `Shop`         | `shop` (key), `plan`, `planCheckedAt`, `planOnStore` (last value written to `$app.plan`), `resolvedAt`                    | #17      |
| `ChartVersion` | `shop`, `chartId`, `createdAt`, `by` (display name or source), `summary`, `snapshot` (json)                               | #24      |
| `Job`          | `shop`, `kind` (`import` or `resolve`), `status` (`running`, `done`, `failed`), `progress`, `result`, `error`, timestamps | #26, #34 |
| `Event`        | `shop`, `id`, `type`, `chartId`, `productId`, `size`, `createdAt`; unique on `(shop, id)`                                 | #44      |
| `AiUsage`      | `shop`, `day`, `count`; key `(shop, day)`                                                                                 | #38      |

Every query filters on the session's shop, and an id sent by a browser is looked up within that shop. `app/uninstalled` deletes the shop's sessions; `shop/redact` deletes every row for the shop in every table; `customers/data_request` and `customers/redact` only acknowledge, because Fitted stores no shopper data. Retention: events 90 days, AI usage 30 days, versions the last 30 per chart, jobs as in §13.

## 15. Errors and retries

- Every failure shows the canvas's light red banner: what failed, what didn't change, Try again. Raw error text from Shopify or OpenAI is logged, never shown.
- Loaders and actions: a failed Shopify call returns status 502 with `{ error: { code, message } }`, and the screen shows its error state. Validation returns 422 with `{ fieldErrors: { "<path>": "<message>" } }`. A stale save returns 409 (§5), a plan gate 403 with the upgrade path, a rate limit 429. 401 and 404 are thrown Responses.
- Admin API: every mutation checks `userErrors`; one helper in `app/models/admin.server.ts` (added by #15) throws on GraphQL errors or user errors. Reads may retry twice with backoff. Writes retry only when they're idempotent, as `metaobjectUpsert` and `metafieldsSet` are.
- Partial success is reported per item (an import's "2 of 11 charts didn't import"), never as all-or-nothing.
- Webhooks return 200 once handled and 500 when they failed, so Shopify retries; handlers are idempotent.
- Storefront: bad or missing data renders nothing; a failed script load shows the guide's error state with Try again.
- Logs: JSON lines to stdout (`level`, `msg`, `shop`, `route`). Never tokens, uploaded files, shopper data or env values.

## 16. Webhooks

Subscribed in `shopify.app.toml`, handled in `app/routes/webhooks.*` (§3):

| Topic                                        | Does                                                      | Step   |
| -------------------------------------------- | --------------------------------------------------------- | ------ |
| `app/uninstalled`                            | Deletes the shop's sessions                               | exists |
| `app/scopes_update`                          | Updates the session's scopes                              | exists |
| `customers/data_request`, `customers/redact` | Acknowledge (no shopper data stored)                      | #16    |
| `shop/redact`                                | Deletes every app database row for the shop               | #16    |
| `products/create`, `products/update`         | Resolve that product's chart (§6)                         | #26    |
| `collections/update`                         | Re-resolve the collection's products when a rule names it | #26    |

The template's demo `products/update` event subscription is removed in #13. App Pricing sends no billing webhooks (§8).

## 17. Hosting and environment

Railway project "Fitted", production environment: one app service (#46) and the Postgres database (#8). One instance only: jobs and the event rate limiter live in its memory. `shopify app deploy` ships the app config and the extension.

Env vars, set on the Railway app service and in local `.env`, never committed: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `DATABASE_URL`, `OPENAI_API_KEY` (a Railway shared variable, referenced as `${{shared.OPENAI_API_KEY}}`), and for the Partner API (§8) `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_ACCESS_TOKEN` and `SHOPIFY_APP_GID`. `.env.example` lists them without values.

## 18. Pipeline

`.github/workflows/`: `ci.yml` (typecheck, lint, format, tests, build, script self-tests and word caps behind one `CI gate` job), `size.yml`, `claude-review.yml` (holds the only copy of the blocker rules), `attribution.yml`, `docs-cap.yml`. Size, Attribution and Claude Review use `pull_request_target`: main's copy of the workflow, a checkout of main, and the PR read only as git objects, so a PR can't edit those gates (it could still add a decoy workflow with the same check name; see GOTCHAS). CI uses `pull_request` and runs the PR's code. The review's OAuth token sits in the `claude-review` environment, which only main can use. `.claude/`: the worker and reviewer agents, `/plan` and `/santa-loop`, careful paths, and settings (dependency hook, deny rules). Shared scripts live in `scripts/`. Steps are GitHub issues in the "Fitted v1" milestone and board; workers run as separate sessions and coordinate on those issues.
