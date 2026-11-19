# Plan

## Status (2026-11-18)

Phase 0, the pipeline, is done. Phase 1 is under way. Merged so far: the architecture and data contracts (#12), admin navigation (#13), Postgres (#14), the chart definition and the chart read and write helpers (#15, #59), plan gating (#17), settings storage (#28) and the privacy webhooks (#16). From phases 2 and 3: Kiwi's terms check (#6) and the fit finder engine (#40). No screen past the empty pages is built yet. The Appearance screen (#65) and the plan-check banner (#56) wait on the owner approving new drawings (#68).

## Phases

0. Pipeline: CI gate, size, Claude Review and attribution checks; main protected.
1. Core app (Free and Standard): charts stored as metaobjects, chart editor, display rules, the size guide as a theme app extension, CSV import and export, plan billing, the mandatory privacy webhooks.
2. Switching from Kiwi: reading charts from the merchant's storefront and product descriptions, PDF and image import, the first-install home and the import flow.
3. Pro: fit finder, translations, analytics.
4. Scale: returns by size (needs Shopify's protected customer data approval), multi-store sync, priority support.
5. Launch: App Store listing, screenshots, privacy policy, review submission.

## Steps

Every step is an issue in the [Fitted v1 milestone](https://github.com/eshan06/fitted/milestone/1), shown on the Fitted v1 project board. Things only the owner can do carry the `owner` label.

## Owner's open items

- Approve the drawings for the plan-check, changed-elsewhere and fix-the-fields states (#68).
- Create the plans in Shopify App Pricing and add the Partner API env vars (#49). Until then every shop reads as Free.
- Approve the privacy policy and the fit finder's privacy wording (#48).
- Before launch: App Store trader details and support contact (#53), then submit (#54).

## Done

- 9597d08 chore: scaffold Shopify app from the React Router template
- #1 chore(ci): add the AI pipeline: CI, review, size and attribution gates
- #2 test(webhooks): cover the uninstall and scopes webhooks
- #3, #4 chore: worktrees ignored; steps as GitHub issues, worker sessions, effort labels
- #55 docs(arch): v1 architecture and data contracts (step #12)
- #57 feat(admin): remove the template demo and add Fitted's navigation (#13)
- #58 feat(db): move the app database to Postgres (#14)
- #60, #66 the chart definition, validation, Admin API helper and chart read and write (#15, #59)
- #61, #62 the fit finder engine (#40)
- #63 plan reading and gating (#17)
- #67 Appearance settings storage (#28)
- #70 the three privacy webhooks (#16)
