# Decisions

Dated entries, newest first. Grep for the area you touch; never read front to back.

## 2026-11-20 Storefront: the guide's styles ride in the snippet, not loader.js

`snippets/guide.liquid` prints Fitted's CSS for the link, the popup and its loading and error states (3.4 KB) as text in an inert `<template>`, and loader.js copies it into its one `<style>`, ahead of the font and the merchant's CSS as before. That took loader.js from 9,944 to about 6,600 of the 10,000 bytes the theme check allows with nothing changing on the page, and a test holds it to 9,000. Moving the popup's code into guide.js instead would leave the loading and error states unstyled while guide.js loads. The cost: each guide's markup carries the CSS (about 1 KB gzipped per page) that cached loader.js carried before. ARCHITECTURE §9.

## 2026-11-20 Storefront: guide.js before an open, only for the fit line

loader.js loads guide.js as an app block's own product page loads when the shopper has answers kept for its chart, so "From your fit finder answers: M fits you" can show before any open. Computing it needs findSize, which loader.js's 10 KB can't hold. Everyone else still loads guide.js on first open. ARCHITECTURE §9, §10.

## 2026-11-18 Data: app-owned definitions; uninstall removes charts in time

Charts, rules and settings use app-owned definitions in `shopify.app.toml`, Shopify's recommended path, with `merchant_read` so only Fitted writes. Shopify deletes app-owned definitions at uninstall and keeps the values only temporarily, so charts don't outlive an uninstall; CSV export on every plan is the way out. Merchant-owned definitions would survive uninstall but let any app or staff edit what the storefront renders. ARCHITECTURE §4.

## 2026-11-18 Charts: numbers and words in separate fields

A chart's `content` json holds structure and numbers and is never translated; `strings` holds the words and carries the translations. Translating one json blob would freeze old numbers inside each translation. The storefront merges source words under the translation, so new words fall back to the primary language. ARCHITECTURE §5, §11.

## 2026-11-18 Billing: the plan comes from the Partner API

Shopify App Pricing reports subscriptions only through the Partner API's `activeSubscription` and sends no webhooks, so the app caches the confirmed plan for 5 minutes and writes it to `$app.plan` for the storefront. This needs three env vars the owner creates: `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_ACCESS_TOKEN`, `SHOPIFY_APP_GID`. ARCHITECTURE §8.

## 2026-11-18 Plans: what each gate covers (owner may change)

Free allows 3 Active charts with unlimited drafts, so a Free merchant can import everything; its rules use the store default, products and collections only, since a chart needs some way onto products. Home's opens stats show on every plan, as the approved Home board draws them on Standard; Pro adds fit finder results. Pro gates Fitted's translation tools, not translations a merchant already has. Downgrades never take anything down. ARCHITECTURE §8.

## 2026-11-18 Storefront: chart data inline, no fetch endpoint

The theme app extension prints each product's chart into the page with Liquid, which also localizes it, and loads the popup script only on first open. Quick view and featured sections get the same app block from the theme, so no chart-fetching endpoint is needed. ARCHITECTURE §9.

## 2026-11-18 App database: versions, jobs, events in Postgres; one instance

Version history, import and resolve jobs, events and AI usage are app-only state in Postgres. Jobs and the event rate limiter run in the app's memory, which holds while Railway runs one instance. ARCHITECTURE §13, §14.

## 2026-11-17 Pipeline: steps are GitHub issues; workers are sessions

The plan's steps live as issues in the "Fitted v1" milestone and project board instead of docs/PLAN.md, so many agents can share one source of truth without editing the same file. Workers run as separate sessions the owner can open and steer, claim their issue, and coordinate in issue comments tagged with their role. Each issue carries its effort label (high, or max on careful paths).

## 2026-11-17 Pipeline: Reviewer B shares Claude's model

No second model (OpenAI or Gemini key) is set up, so /santa-loop's Reviewer B is a second Claude and every report says so. Add a key and switch B to `codex exec` or the Gemini CLI when one exists.

## 2026-11-17 Stack: Shopify's React Router template, TypeScript, npm

Scaffolded with `shopify app init --template reactRouter --flavor typescript`. Vitest added for tests. Railway (already used by the owner) is the hosting target; AWS is not needed.

## 2026-11-17 Data: merchant data lives in the merchant's store

Charts are metaobjects and settings are metafields in the merchant's store, so data is never locked in Fitted (Kiwi's lock-in is a top complaint). CSV export on every plan.

## 2026-11-17 Pricing: flat, no order fees

Free (3 charts), Standard $9, Pro $15 (fit finder, every store language, analytics), Scale $29 (returns by size, multi-store sync, priority support); yearly plans give two months free. No order-volume fees: they are the main complaint in Kiwi's reviews. Free import from Kiwi on every plan.

## 2026-11-17 Design: the canvas is the approved UI

The Fitted canvas (https://claude.ai/artifact/NbMEAjXndPF7RG4RnASgpL) holds the approved screens, in the "Pattern Envelope" style for shopper-facing pages and Shopify-native Polaris for admin.

## 2026-11-17 Repo: market research stays out

The repo is public, so `reports/` and `research_notes/` are gitignored and stay on the owner's machine.
