# Architecture: storefront

Part of docs/ARCHITECTURE.md (§9 to §12); its rules bind the same way.

## 9. Storefront

The size guide is one theme app extension, `extensions/size-guide/`:

- App block `blocks/size-guide.liquid` for the product page next to the size picker. A theme's quick view that loads the product page's main section (the dev store's Dawn-based quick add does, #32) brings the block along, and featured product sections take it too, with the product autofilled.
- App embed `blocks/embed.liquid`, which works in every theme: on product pages with a chart, the floating tab and the link after the merchant's CSS selector, per `settings.placement`; and `loader.js` on every page while `placement.quickView` is on, as a quick view brings the block but not its script.
- Both render `snippets/guide.liquid`, the link and popup, with `data-place`: `main` (the block on its own product page, or a quick view of it), `featured` (the block anywhere else), `tab` or `after` (the embed). The loader shows `main` on a product page when `productBlock` is on, marked `data-page`; inside a theme popup (`dialog` or `[role=dialog]`) when `quickView` is on; `featured` when `featured` is on; the tab whenever the embed prints it (`floatingTab` on, or link style `tab`). It shows `after` once the selector matches, maybe later, right after that element, and puts it back whenever the theme redraws it (marked `data-placed`). The embed's styles hide the `data-page` link while its tab, as the link style, or its placed link stands in ("Leave empty to use the app block"), so with the embed off, or a selector that matches nothing, that link still shows. The tab's styles come with its Liquid, since `loader.js` has no room for them. Escape, wherever focus is, closes the guide on key up and stops both keys, so a quick view under it stays open.
- A snippet prints the data once per guide (the block, the tab and the selector's link each print it) as `<script type="application/json" data-fitted>`, always through `| json` (which escapes `<`), never a raw `.value`: the chart's `content` and `strings` (Liquid gives the shopper's locale), the image URL, the settings the guide uses, the plan, and the locale. `content.fit` is left out unless the plan is `pro`.

Liquid reads `product.metafields["$app"].chart.value`, `shop.metafields["$app"].settings.value` and `shop.metafields["$app"].plan.value`; the `$app` prefix resolves only inside the extension. The guide's script re-validates what it reads, because translations can come from any app with `write_translations` (§11). No chart (the metafield is empty, the chart is Draft, or its data doesn't parse) means nothing renders: no link, no tab.

Tabs, in order: Size chart (every table under its heading, its note, then `tips`); How to measure (the drawing for `template`, `measure_image`, the steps and the video), shown when the chart has steps, an image or a video; Find my size (§10). With one tab, there is no tab bar.

Size chart tab: a table whose country columns name two or more systems shows one at a time behind the US/UK/EU/AU switch, starting with the shopper's system (by country), else the first system of the first such table; a table without that system shows its own first. The in/cm toggle shows when `units.toggle` is on and a column converts. Picking a row lights up that size in every table and fills the sticky footer. Its Select sets the size in the theme's product form: a radio or select whose value matches the size label, in the smallest ancestor of the block holding a `/cart/add` form, never past the block's section. Each open starts on the size the form shows. Themes with other size controls get the footer without Select.

Data is inline, so opening the guide fetches nothing but `guide.js`; its only other request is the open's event (§12). JavaScript: `assets/loader.js`, under 10 KB as stored (Shopify's suggested limit, which the CLI's theme check measures on the file itself), shows the link once the chart validates and loads `assets/guide.js` with `import()` on first open. The canvas's loading state shows while that import runs; its error state, with Try again, shows if it fails. `snippets/guide.liquid` prints the popup's frame and those two states as Liquid markup, so their words come from the extension's locales through `t`; the loader adds the guide's styles (`css` in `app/lib/guide-css.ts`) once, so nothing render-blocking lands in the theme's `<head>`, and `render` adds the tables' (`tableCss`) when it first draws. Liquid stays under the extension's 100 KB limit.

Shared code: storefront logic is written in `app/lib/` (the guide renderer and `fit-finder.ts`), with no dependencies and no React, and built into `extensions/size-guide/assets/` by an npm script. The built files are committed and excluded from Prettier and ESLint; a test that fails when they differ from a fresh build is their gate. The admin live preview (#23) renders with the same module, so it matches the storefront.

Units: `settings.units.default` of `country` shows inches when `localization.country.iso_code` is US, LR or MM, centimeters elsewhere. Conversion uses 2.54 cm per inch and 0.4536 kg per pound, rounded to `content.roundTo`. Fit videos are embedded from the video id that Fitted parses out of the link, never from the raw URL.

Appearance (§7, #31): the data snippet prints `link`, `popup`, `placement`, `colors`, `css` and the shopper's `text` (else the primary locale's) through `| json`, and the loader applies them as text and CSS values after the checks in `app/lib/appearance.ts`, the ones the settings model saves with. The link shows `label` and the popup's title `header`, else the extension's word; `link.icon` of `none` drops the ruler. `popup.rtl` sets `dir="rtl"` on the popup. Classes are prefixed `fitted-`; the loader adds Fitted's styles, the uploaded font's `@font-face` and then the custom CSS, as written, in one `<style>`, so it reaches every page where a guide shows as theme CSS does, and `render` puts the tables' styles before it. Colors follow the theme unless `colors.mode` is custom: the theme's text color where the block sits, the nearest opaque background behind it (with near-black or white text instead when the theme's doesn't read 4.5:1 on it, as under a gradient), and the canvas's accent where it reads 4.5:1 on that background, else the text color. The loader sets those three on `.fitted-guide` on each open and the other shades mix from them, so custom colors reach the popup, never the link. The font follows the theme unless `popup.font` names a file, which then sets the popup's font, with the theme's behind it.

## 10. Fit finder

`app/lib/fit-finder.ts` (#40) is a pure function the storefront and the admin preview share: given a chart's table, the answers, and the chart's fit settings, it returns the recommended size row (or none), a reason as a key in the extension's `locales/*.json` with its values, and fit bars (0 to 100, tight to loose) for every size and measured column. A chart's fit settings sit in `content.fit`:

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

Question texts are `words` keys (§5). There are no other kinds: Basic asks height and weight as `measure` questions, and `askAge` adds a `choice` question whose options narrow the rows.

`findSize(chart, answers)` takes answers by question id (a measure as `{ value, unit }` in the unit the shopper typed, converted to the column's unit; a row id; `snug`/`regular`/`relaxed`; an option id) and ignores any it can't use. The rules, in order:

- Choice answers narrow the rows; sizes keep table order, smallest first.
- Each measurement plus `ease` falls in a row's range (on length columns, stretch lets a row fit 3% past its top value for `some`, 6% for `high`, though a row whose own range holds the value wins), between two rows, or off the chart. Between sizes takes the larger, or the smaller for snug. With several measurements the largest pick wins, a between pick on a tie; any past the largest size recommends nothing, and one below the smallest is ignored unless all are.
- No usable measurement: the usual size, if choices left it. Neither: the one row left by choices, else nothing.
- Snug moves an in-range or usual pick one size down, relaxed one up, never past either end.

Reason keys are `fit.reason.` plus `in`, `in.up`, `in.down`, `between`, `small`, `large`, `usual`, `usual.up`, `usual.down`, `choice` or `none`. Their values: `col`, `value` and `unit` as typed for measurements; `size` (the pick, or the nearest size when off the chart), `from` (before the fit move), `below` and `above` as row ids; `fit` when answered, except on `none`. Fit bars score each remaining row per measured column: 50 at its midpoint (stretch included), 25 more per size step looser.

Fitted never sends or stores the answers: no request carries one, and nothing reaches a server. They sit only in `sessionStorage` under `fitted:answers:<chart handle>`, so another product with the same chart reuses them until the tab closes. Other scripts on the store can read the page, so the measurements note (#48) promises only what Fitted does. Events (§12) carry only a size row id. The storefront shows Find my size only when `$app.plan` is `pro` and the chart has `fit`.

## 11. Translations

Chart words: `strings` is the only chart field that carries translations. They're registered with `translationsRegister` on the chart metaobject, using the digest from `translatableResourcesByIds`, and Liquid renders each shopper's language. The storefront merges `{ ...content.words, ...strings }`, so an untranslated word shows in the primary language, and numbers never go stale because no translated field holds them. When a merchant edits a chart, Shopify marks that chart's translations outdated. From #43 on (it adds `write_translations`), each save removes translations registered on every field but `strings`; a translated `template` would lose the drawing.

Translate all charts (#43, Pro) fills missing and outdated locales through OpenAI (§13), one call per chart and locale carrying all its words and keys. The answer passes the §5 word rules before it's registered. Per store language (`shopLocales`), the Appearance screen shows: the primary locale as Published; Translated when every Active chart has a current translation; Needs review when any is outdated; otherwise Not translated. At the OpenAI budget, Translate stops, keeps what it finished, and says when it can continue. The canvas's Review button opens a screen the canvas doesn't draw yet, so #43 gets it drawn first.

Settings words (`settings.text`) are kept per locale by Fitted and filled by the same Translate action. The guide's own interface words (tab names, Tight to Loose, buttons) are the extension's `locales/*.json` files, and languages Fitted doesn't ship fall back to English.

## 12. Events and stats

Shoppers' browsers post events to the app proxy: `shopify.app.toml` sets `[app_proxy]` with url `/proxy`, prefix `apps` and subpath `fitted`, and `POST /apps/fitted/events` reaches `app/routes/proxy.events.tsx` (#44). `guide.js` sends `open` on every open, naming the chart and product GIDs the guide snippet prints as `data-chart` and `data-product`; the snippet prints none in the theme editor, so a merchant's tries aren't counted, and without them (the admin preview too) nothing is sent. #42 sends `fit_result` and `add_to_cart`.

- Body: JSON text of at most 1 KB, sent with `navigator.sendBeacon`: `{ id, type, chart, product, size? }`, where `id` is a UUID v4, `type` is `open`, `fit_result` or `add_to_cart`, `chart` and `product` are GIDs, and `size` is the size row id that was recommended (`fit_result`, left out when nothing fit) or added (`add_to_cart`, always), checked against the §5 id pattern, and never on `open`. Unknown keys are refused.
- Verify: a `shop` that isn't a `.myshopify.com` domain is refused before the library logs it; then `authenticate.public.appProxy` checks the signature and refuses a `timestamp` more than 90 seconds off (it also loads the shop's offline session, which this endpoint doesn't use); the shop comes only from the verified request.
- No shopper data: `logged_in_customer_id`, the IP address and the user agent are never stored. The client IP is used only in memory, for rate limiting, as a keyed hash whose key never leaves the process: 30 requests a minute per IP and shop, and 20,000 stored events a UTC day per shop, counted from the table on the shop's first event of the day so a restart keeps it (a day with 20,000 rows is one that hit the cap), in bounded maps whose entries expire. Railway and Shopify add their own `X-Forwarded-For` entries, so #44 confirms on the dev store which entry is the shopper's; until then the code takes the last entry but one (Shopify's, before the host's), and without one only the day's cap applies.
- Replay: a repeated `(shop, id)` returns success without a second row.
- Responses: 204 recorded or duplicate, 400 bad input, a bad signature or a stale timestamp (the library's answer for the last two), 429 over a limit, 500 a failed write. The storefront never retries an event or shows its failure, since no shopper action failed; the server logs every failed write.

Rows go to the `Event` table (§14) and are deleted after 90 days by the job checks (§13). Stats count only events whose chart is one of the shop's charts, with size row ids shown as their primary-language labels. Home (#45) shows opens in the last 30 days, the most opened chart and opens per chart on every plan, fit finder results on Pro, and says when a day hit the shop's event cap. When the store has `window.gtag`, the storefront also sends (#45) `fitted_open`, `fitted_fit_result` and `fitted_add_to_cart` through it, with the chart handle as the only parameter, so the store's own GA and consent setup apply; Fitted stores no GA ids.
