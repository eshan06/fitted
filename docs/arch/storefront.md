# Architecture: storefront

Part of docs/ARCHITECTURE.md (§9 to §12); its rules bind the same way.

## 9. Storefront

The size guide is one theme app extension, `extensions/size-guide/`:

- App block `blocks/size-guide.liquid` for the product page next to the size picker. Themes that render app blocks in their quick view and featured product sections show it there too (#32 confirms on the dev store's theme).
- App embed `blocks/embed.liquid` for the floating tab and the CSS-selector placement, on product pages only, per `settings.placement`.
- A snippet prints the data once per product as `<script type="application/json" data-fitted>`, always through `| json` (which escapes `<`), never a raw `.value`: the chart's `content` and `strings` (Liquid gives the shopper's locale), the image URL, the settings the guide uses, the plan, and the locale. `content.fit` is left out unless the plan is `pro`.

Liquid reads `product.metafields["$app"].chart.value`, `shop.metafields["$app"].settings.value` and `shop.metafields["$app"].plan.value`; the `$app` prefix resolves only inside the extension. The guide's script re-validates what it reads, because translations can come from any app with `write_translations` (§11). No chart (the metafield is empty, the chart is Draft, or its data doesn't parse) means nothing renders: no link, no tab.

Tabs, in order: Size chart (every table under its heading, its note, then `tips`); How to measure (the drawing for `template`, `measure_image`, the steps and the video), shown when the chart has steps, an image or a video; Find my size (§10). With one tab, there is no tab bar.

Data is inline, so opening the guide makes no request. JavaScript: `assets/loader.js`, at most 10 KB compressed (Shopify's suggested limit), renders the link and loads `assets/guide.js` with `import()` on first open. The canvas's loading state shows while that import runs; its error state, with Try again, shows if it fails. Liquid stays under the extension's 100 KB limit.

Shared code: storefront logic is written in `app/lib/` (the guide renderer and `fit-finder.ts`), with no dependencies and no React, and built into `extensions/size-guide/assets/` by an npm script. The built files are committed and excluded from Prettier and ESLint; a test that fails when they differ from a fresh build is their gate. The admin live preview (#23) renders with the same module, so it matches the storefront.

Units: `settings.units.default` of `country` shows inches when `localization.country.iso_code` is US, LR or MM, centimeters elsewhere. Conversion uses 2.54 cm per inch and 0.4536 kg per pound, rounded to `content.roundTo`. Classes are prefixed `fitted-`; custom CSS is printed in one `<style>`. Colors follow the theme unless `colors.mode` is custom; the font follows the theme unless `popup.font` names a file. `popup.rtl` sets `dir="rtl"` on the popup. Fit videos are embedded from the video id that Fitted parses out of the link, never from the raw URL.

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

Question texts are `words` keys (§5). #40 may add question kinds (age, for the Basic type); it records them here.

Fitted never sends or stores the answers: no request carries one, and nothing reaches a server. They sit only in `sessionStorage` under `fitted:answers:<chart handle>`, so another product with the same chart reuses them until the tab closes. Other scripts on the store can read the page, so the measurements note (#48) promises only what Fitted does. Events (§12) carry only a size row id. The storefront shows Find my size only when `$app.plan` is `pro` and the chart has `fit`.

## 11. Translations

Chart words: `strings` is the only chart field that carries translations. They're registered with `translationsRegister` on the chart metaobject, using the digest from `translatableResourcesByIds`, and Liquid renders each shopper's language. The storefront merges `{ ...content.words, ...strings }`, so an untranslated word shows in the primary language, and numbers never go stale because no translated field holds them. When a merchant edits a chart, Shopify marks that chart's translations outdated. From #43 on (it adds `write_translations`), each save removes translations registered on every field but `strings`; a translated `template` would lose the drawing.

Translate all charts (#43, Pro) fills missing and outdated locales through OpenAI (§13), one call per chart and locale carrying all its words and keys. The answer passes the §5 word rules before it's registered. Per store language (`shopLocales`), the Appearance screen shows: the primary locale as Published; Translated when every Active chart has a current translation; Needs review when any is outdated; otherwise Not translated. At the OpenAI budget, Translate stops, keeps what it finished, and says when it can continue. The canvas's Review button opens a screen the canvas doesn't draw yet, so #43 gets it drawn first.

Settings words (`settings.text`) are kept per locale by Fitted and filled by the same Translate action. The guide's own interface words (tab names, Tight to Loose, buttons) are the extension's `locales/*.json` files, and languages Fitted doesn't ship fall back to English.

## 12. Events and stats

Shoppers' browsers post events to the app proxy: `shopify.app.toml` sets `[app_proxy]` with prefix `apps` and subpath `fitted`, and `POST /apps/fitted/events` reaches `app/routes/proxy.events.tsx` (#44).

- Body: JSON text of at most 1 KB, sent with `navigator.sendBeacon`: `{ id, type, chart, product, size? }`, where `id` is a UUID v4, `type` is `open`, `fit_result` or `add_to_cart`, `chart` and `product` are GIDs, and `size` is the size row id that was recommended (`fit_result`) or added (`add_to_cart`). Unknown keys are refused.
- Verify: `authenticate.public.appProxy` checks the signature; a `timestamp` over 5 minutes old is refused; the shop comes only from the verified request.
- No shopper data: `logged_in_customer_id`, the IP address and the user agent are never stored. The client IP is used only in memory, for rate limiting: 30 events a minute per IP and shop, and 20,000 a day per shop, in a bounded map whose entries expire. Railway and Shopify add their own `X-Forwarded-For` entries, so #44 confirms on the dev store which entry is the shopper's.
- Replay: a repeated `(shop, id)` returns success without a second row.
- Responses: 204 recorded or duplicate, 400 bad input or a bad signature (the library's answer), 401 a stale timestamp, 429 over the limit. The storefront never retries an event or shows its failure: the one deliberate exception to CLAUDE.md's no silent failures, since no shopper action failed.

Rows go to the `Event` table (§14) and are deleted after 90 days. Stats count only events whose chart is one of the shop's charts, with size row ids shown as their primary-language labels. Home (#45) shows opens in the last 30 days, the most opened chart and opens per chart on every plan, fit finder results on Pro, and says when a day hit the shop's event cap. When the store has `window.gtag`, the storefront also sends `fitted_open`, `fitted_fit_result` and `fitted_add_to_cart` through it, with the chart handle as the only parameter, so the store's own GA and consent setup apply; Fitted stores no GA ids.
