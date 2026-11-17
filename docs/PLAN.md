# Plan

## Status (2026-11-17)

Phase 0, the pipeline, is in its first PR (chore/pipeline). The app is scaffolded from Shopify's template; nothing Fitted-specific is built yet.

## Phases

0. Pipeline: CI gate, size, Claude Review and attribution checks; main protected.
1. Core app (Free and Standard): charts stored as metaobjects, chart editor, display rules, the size guide as a theme app extension, CSV import and export, plan billing, the mandatory privacy webhooks.
2. Switching from Kiwi: reading charts from the merchant's storefront and product descriptions, PDF and image import, the first-install home and the import flow.
3. Pro: fit finder, translations, analytics.
4. Scale: returns by size (needs Shopify's protected customer data approval), multi-store sync, priority support.
5. Launch: App Store listing, screenshots, privacy policy, review submission.

## Open steps

None yet. Run /plan on phase 1 once the pipeline is proven.

## Owner's open items

- Add the CLAUDE_CODE_OAUTH_TOKEN secret (`claude setup-token`).
- Create a development store for `npm run dev`.
- Before phase 2: confirm Kiwi's terms allow reading charts from a merchant's own live storefront.
- Final privacy wording for the fit finder.
- Before launch: a Railway project for hosting; App Store trader details.

## Done

- 9597d08 chore: scaffold Shopify app from the React Router template
