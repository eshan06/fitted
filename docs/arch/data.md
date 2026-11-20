# Architecture: store data and plans

Part of docs/ARCHITECTURE.md (§5 to §8); its rules bind the same way.

## 5. Size chart

One metaobject per chart, type `$app:chart`, defined in `shopify.app.toml`:

- `access.admin = "merchant_read"`, `access.storefront = "public_read"` (Liquid needs it). `public_read` exposes every field through the Storefront API, so nothing in a chart is private, `name` and `import_note` included.
- `capabilities.publishable = true`: status `ACTIVE` is what the screens call Published or Active; `DRAFT` is Draft. Drafts never reach shoppers. Imports and new charts start as Draft.
- `capabilities.translatable = true` (§11).
- Handle: minted before the first create request and resent on every retry, so a retried create upserts the same chart instead of making a second one. The new-chart screen mints `c-` plus 10 random `[a-z0-9]` when it loads; an import mints `i-<job id>-<draft index>`. Creates use `metaobjectUpsert` with the handle; later writes use `metaobjectUpdate` by id, so a chart deleted meanwhile stays deleted. A create whose handle already belongs to a different chart is refused, and a handle sent by a browser must match `c-[a-z0-9]{10}`. It never changes and means nothing: it shows in the Copy link URL, GA events and the guide's storage key.

| Field           | Type                                      | Holds                                                                                                                                                                |
| --------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | single_line_text_field, required          | Admin name, at most 100 characters; `display_name_field`. Not shown in the size guide.                                                                               |
| `template`      | single_line_text_field, required, choices | `blank`, `tops`, `bottoms`, `dresses`, `bras_swimwear`, `shoes`, `kids`, `headwear`, `rings`, `bracelets`, `necklaces`. Picks the garment drawing in the size guide. |
| `content`       | json, required                            | Structure, numbers and the source words (below). Never translated.                                                                                                   |
| `strings`       | json, required                            | The same map as `content.words`. The one field translations are registered on (§11).                                                                                 |
| `measure_image` | file_reference                            | Optional How to measure image (PNG or JPG).                                                                                                                          |
| `import_note`   | single_line_text_field                    | Note an import leaves for the admin screens ("Check units"); cleared by the next save from the editor.                                                               |

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

Numbers in `content`, words in `words`: a row's `cells` hold only measure columns, as `[value]` or `[min, max]` in the column's unit (`unit` or the chart's), each above 0 and below 10,000, min at most max; an empty cell is a missing key. Every text is a `words` entry: `<table>.title`, `<table>.sub`, `<table>.note`, `<table>.<col>` (column label), `<table>.<row>.<col>` (size, country and text cells), `m.<step>.name`, `m.<step>.text`, `tips`, and the fit finder's `fit.<question>` and `fit.<question>.<option>`. Ids match `[a-z0-9]{1,8}`, are unique within the chart (a fit option's id only within its question), and `title`, `sub` and `note` are reserved. A merge stays inside its table and never overlaps another; cells it covers, other than its top-left cell, are ignored. `convert: false` keeps a column as typed for shoppers. Country columns show one at a time behind a US/UK/EU/AU switch when a table's country columns name two or more systems. `content` stays under 100 KB (Shopify caps json at 128 KB).

Words are plain text, at most 500 characters each and `tips` at most 2,000. No text in a chart (name, words, video link, import note) holds a NUL character: CSV import refuses the byte, and Postgres json can't store it. They reach a page only as values Liquid or the guide's script prints escaped (`| escape`, `| json`, `textContent`); app code never puts chart or settings text into a Liquid template's source, where `{%` would run.

`app/models/chart.server.ts` owns the definition's reads and writes (#59) and one validator (#15) that every write goes through: the editor, imports, restores, templates, duplicates and OpenAI output. Invalid input is refused with a field path and a plain message. A chart that fails validation when read shows as an error on that chart; it is never dropped silently. It writes `strings` equal to `content.words` on every save. Templates (#25) live in `app/data/templates/` and set columns, size rows, measure steps and words, never numbers.

Free plan: at most 3 Active charts; drafts are unlimited (§8).

Version history (#24) is in Postgres (§14). The chart in Shopify is the current version, and `ChartVersion` rows are its history: each successful save, restore, import or template creation adds a row holding the saved fields, who saved it, and a one-line summary of what changed. Restoring saves an old snapshot as a new version, so nothing is lost. Fitted keeps the last 30 versions per chart (the canvas's [VERSION LIMIT]; the owner can change the number). If the Shopify write fails, no version is recorded; if only the version write fails, the merchant is told the chart saved but history missed that save.

Concurrent edits: a save sends the `updatedAt` the editor loaded; if the chart changed since, the save is refused with "This chart changed since you opened it" and a reload, never a silent overwrite.

Copy link (#127) gives `https://<shop>/apps/fitted/charts/<handle>`, an app proxy page (`app/routes/proxy.charts.$handle.tsx`) in the store's theme layout. The route verifies the proxy signature, checks the handle's format, and returns one fixed Liquid template that looks the Active chart up by handle and prints every value escaped. The route makes no Admin API call, so anonymous visits can't spend the shop's rate limit; a Draft or unknown handle renders the template's not-found state. Outside the extension `$app` doesn't resolve, so the template names the type as `app--<app id>--chart` (confirm in #127). The canvas doesn't draw this page yet, so it gets drawn first.

## 6. Display rules

Rules live in one shop metafield, `$app.rules` (json, under 100 KB):

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

A chart matches a product when any `match` condition holds and no `exclude` condition does. For facts with several values (tags, collections, list metafields), `is` and `contains` hold when any value matches, and `is_not` holds when none does. Text compares are trimmed and case-insensitive; `contains` is a substring test. `key` is `namespace.key`, each part `[A-Za-z0-9_-]{1,64}`, because it is written into the full resolve's bulk query text, and never an app's own `app--` namespace: another app's can't be read, and Fitted's holds `chart`, so a product's chart would depend on itself. Across charts, the first chart in `order` that matches and is Active wins; a Draft chart is skipped, so its products fall through to the next match. At most 1,000 product and collection ids across all rules; past that the save is refused with a suggestion to use a tag or collection, and an import reports per chart which assignments didn't fit. At most 200 charts in `order` and 20 different metafield keys, so one product's resolve query, which reads every ranked chart's status and every compared metafield, stays under Shopify's query cost limit; text values are 1 to 255 characters. `app/models/rules.server.ts` (#26) validates the whole document on every write and read; a stored value that fails validation stops a resolve instead of unassigning every product, and reaches the screen as its own error with the digest, so a valid save can replace it.

Rules and settings are written whole with `metafieldsSet` and the `compareDigest` the screen loaded, so a write over someone else's newer save (another tab, an import finishing) is refused with the 409 of §15 instead of dropping their changes. An import job, which has no screen to show a 409, re-reads the rules and merges its additions instead.

Resolution is a pure function, `resolveChart(product, rules, activeChartIds)`, returning a chart GID or null, where `product` is `{ id, tags, productType, vendor, collectionIds, metafields }` and `metafields` maps each compared `namespace.key` to its values (every item of a list). Its result is written to the product metafield `$app.chart` (`metaobject_reference<$app:chart>`, `merchant_read`, `capabilities.admin_filterable = true`) only when it differs from the current value; null removes it with `metafieldsDelete`. Only the resolver writes it.

When it runs (full resolve #73, started by the chart editor in #83, webhooks #74, job checks and the Home reconcile #86):

- Full resolve, as a `resolve` job (§13): after a rules save, after a chart is published, unpublished or deleted, and from the Home loader (`resolveIfStale`) when the shop's newest resolve started over 24 hours ago, finished or failed, so a failing shop starts again once a day, not on every load (this catches missed webhooks without a scheduler). A bulk query reads every product's facts and current chart; assignments go out in a bulk mutation of `metafieldsSet`, 25 metafields per line, and removals in `metafieldsDelete` batches of 25. A rules change while a resolve runs makes it run once more when it finishes. Which charts are Active comes from the chart list (§5), read in id order, so a ranked id that is deleted or not a chart never matches. A pass that applies every change it found sets `Shop.resolvedAt` to its start. `metafieldsSet` is atomic, so a line Shopify refuses (a product deleted mid-pass) leaves its products unchanged: the second pass redoes them, and refusals in the second pass fail the job. A bulk operation is polled every 3 seconds and given up after 2 hours.
- One product: `products/create` and `products/update` resolve that product (`productChanged`). It reads the rules, then in one query the product's facts, its chart, its first 250 collections when a rule names one, and the status of every ranked chart, so a ranked id that isn't an Active chart of Fitted's never matches.
- `collections/update` and `collections/delete` start a full resolve, not the merchant's, when a rule names the collection (`collectionChanged`): the collection's own product list can't show the products that left it.
- Charts with `auto: false` ("Apply to new products automatically" off) are assigned only by full resolves the merchant causes: a rules save, or a chart published, unpublished or deleted. Webhooks and the 24-hour reconcile neither add nor remove them, unless their run was queued behind a merchant resolve that failed and so runs as the merchant's (§13): a product whose current chart is an `auto: false` chart is left alone, and other products resolve with `auto: false` charts left out of `activeChartIds`.

Echoes: Fitted's own metafield writes and deletes do trigger `products/update`, about 5 seconds later, with an `updated_at` after the write (seen on the dev store in #26). The webhook subscribes with `include_fields = ["id", "updated_at"]`, which also keeps every delivery distinct, so Shopify never debounces a merchant edit away. A delivery whose `updated_at` is at least a second earlier than `Shop.resolvedAt` is skipped (`updated_at` has whole seconds), because the pass that set it read the product afterwards and applied what it found. A delivery that arrives while the shop's full resolve runs is held in memory, the newest `updated_at` per product, until the resolve finishes, and then meets that skip: the first pass's echoes, and edits the second pass read, cost nothing more, and the rest resolve one by one. A full resolve ends with a second pass, which covers products edited during the first. So the echoes that still cost a rules read and a product read are the second pass's few changes and one per chart a webhook changes; comparing before writing stops the loop, and no delivery is dropped for being an echo. Held deliveries were answered already, so Shopify won't send them again: the first one whose own resolve fails ends the round, and a full resolve reads the rest, another one after a clean resolve and the failed job's requeue (§13) after a failed one. A restart loses them; mid-resolve the job's requeue reads every product, and once the job is done only the 24-hour reconcile does.

Two cheaper ways were checked in #74 and not taken. A first read comparing a product's `updatedAt` with its chart's would drop a merchant edit made in the same second as Fitted's write: the two deliveries look alike, and Shopify debounces them into one. Shopify's Events (general since API 2026-10) would never deliver an echo and run the read for free, but their metafield triggers must name a namespace, while rules compare merchant-chosen metafields in any namespace; revisit them when a trigger can watch every metafield, tested on the dev store.

Counts: "Shown on 148 products" and "Products with a chart: 312 of 340" are `productsCount` queries on the metafield: `metafields.$app.chart:"<gid>"`, and `-metafields.$app.chart:*` for products without one. The `$app` form works in these queries (checked on the dev store in #26 against an `admin_filterable` metaobject reference); the index caught up within a minute of a write.

Free plan: rules use only `all`, `product` and `collection` conditions; Standard and Pro use every field. Rules saved on a paid plan keep resolving after a downgrade; they just can't be edited into new paid conditions: on Free, a save keeps a paid condition only when the same chart already has it, unchanged, in the same list (`match` or `exclude`), and anything else is refused with the 403 of §15.

## 7. Settings and plan metafields

`$app.settings` is a shop metafield (json, `merchant_read`), written whole by the Appearance and Fit finder screens through `app/models/settings.server.ts` (with `compareDigest`, §6), which validates it and fills defaults on read:

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
  css: string; // at most 10 KB; no "<", "\" or @import; loads files only through url() to Shopify Files
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

Colors are `#rrggbb`. `fileUrl` is an `https://cdn.shopify.com/` URL (an upload to Shopify Files) with no quote, parenthesis, backslash, whitespace or `<`. `selector` is at most 200 characters and only used in `querySelector`. `text` values follow the §5 word rules, at most 200 characters, are kept per locale by Fitted (§11), and fall back to the primary locale. `fitFinder.type` decides which question kinds (§10) the Fit finder screen offers: `basic` asks height and weight as `measure` questions plus `fit`, and `askAge` (Basic only) adds an age `choice`; `advanced` asks the chart's body measurements (`measure`), `usual_size` and `fit`; `custom` offers every kind, `choice` included. `askAge` is stored on any type and takes effect only on Basic.

`$app.plan` is a shop metafield (single_line_text_field, choices `free`, `standard`, `pro`), written only by the billing module after a confirmed plan read (§8). The storefront reads it to show or hide Pro features.

Liquid reads app-owned metafields whatever their storefront access, so none of these need `public_read`. Liquid prints `css` into the page, which is why only Fitted may write it (§4); with no storefront access, these metafields can't carry another app's translations either (Shopify translates only publicly accessible metafields).

## 8. Plans and gating

Fitted bills through Shopify App Pricing: plans are set up in the Partner Dashboard (#49) with handles `free`, `standard` and `pro`, monthly and yearly. The app never creates charges. The active plan comes from the Partner API's `activeSubscription(appId, shopId)` (its `items[].handle`, and its `billingPeriod` for the price Home shows), not the Admin API, and App Pricing sends no webhooks. The Partner API token is created with the least access that allows that query. `app/models/billing.server.ts` (#17):

- Caches the confirmed plan, and whether it's billed yearly, on the `Shop` row and re-checks when it is over 5 minutes old, on the next admin load. The welcome link after a plan change carries `plan_handle`; the app re-checks at once.
- Every check, failed or not, keeps at least 10 seconds from the shop's last one, and a 429 from the Partner API backs off; the Partner API's rate limit is shared across every shop. A welcome-link check inside the gap is delayed, never dropped.
- If a plan check fails, it keeps the last confirmed plan (Free if none) and shows a banner saying the plan couldn't be checked, with Try again. A failed check never changes the storefront: `$app.plan` changes only on a confirmed read.
- A cached plan the database can't give counts as a failed check, with no call to Shopify: it keeps the plan the app last read or confirmed for the shop, held in memory (so Free after a restart until a read succeeds) and cleared at uninstall. `getPlan` never fails a screen or loses its edits.
- A missing subscription or an unknown handle is Free. An unknown `billingPeriod` still confirms the plan; on a paid plan Home then shows no plan banner rather than guess a price.
- After a confirmed read, it writes `$app.plan` with the offline session (a staff member's own access may not allow it) when the plan differs from `Shop.planOnStore`. `app/uninstalled` resets the cached plan to Free and clears `planYearly`, `planOnStore` and `planCheckedAt`, so a reinstall always checks and writes again, and reads as Free, not the plan from before, if that check fails.
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
