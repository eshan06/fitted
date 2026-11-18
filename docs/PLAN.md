# Plan

## Status (2026-11-17)

Phase 0, the pipeline, is done and proven end to end by PR #2 (merged). main is protected by the "Protect main" ruleset. Nothing Fitted-specific is built yet.

## Phases

0. Pipeline: CI gate, size, Claude Review and attribution checks; main protected.
1. Core app (Free and Standard): charts stored as metaobjects, chart editor, display rules, the size guide as a theme app extension, CSV import and export, plan billing, the mandatory privacy webhooks.
2. Switching from Kiwi: reading charts from the merchant's storefront and product descriptions, PDF and image import, the first-install home and the import flow.
3. Pro: fit finder, translations, analytics.
4. Scale: returns by size (needs Shopify's protected customer data approval), multi-store sync, priority support.
5. Launch: App Store listing, screenshots, privacy policy, review submission.

## Open steps

None yet. Next: /plan on phase 1.

## Owner's open items

- Move CLAUDE_CODE_OAUTH_TOKEN from a repo secret into the `claude-review` environment, then delete the repo copy.
- Create a development store for `npm run dev`.
- Before phase 2: confirm Kiwi's terms allow reading charts from a merchant's own live storefront.
- Final privacy wording for the fit finder.
- Before launch: a Railway project for hosting; App Store trader details.

## Done

- 9597d08 chore: scaffold Shopify app from the React Router template
- #1 chore(ci): add the AI pipeline: CI, review, size and attribution gates
- #2 test(webhooks): cover the uninstall and scopes webhooks
