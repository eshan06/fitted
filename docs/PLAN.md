# Plan

## Status (2026-11-19)

Phase 0, the pipeline, is done. Phase 1 is well under way, with every model and job under the screens merged:

- the architecture (#12), navigation (#13) and Postgres (#14)
- chart storage (#15, #59) and the editor's save logic (#20)
- plan gating (#17), settings storage (#28) and the privacy webhooks and uninstall cleanup (#16, #64)
- display rules: the model, the resolve job, publish triggers and product webhooks (#26, #73, #83, #74)
- CSV export and import of Fitted's own layout (#33, #75)
- the first half of the product-page size guide (#29)

From later phases: the Kiwi scan (#35, which found Kiwi's charts can't be read from the store), the fit finder engine (#40) and the draft privacy and support pages (#47).

No admin screen past the empty pages is built yet. Nine screens wait on the owner approving the drawings on #68. Running now: the rest of the size guide (#88), job retries (#86) and spreadsheet import (#76).

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

- Approve the drawings from three passes; this unblocks nine screens (#68).
- Decide whether Fitted may read Kiwi's chart server for the merchant's own shop (#80).
- Create the plans in Shopify App Pricing and add the Partner API env vars (#49). Until then every shop reads as Free.
- Set the Shopify app secret in Railway so the deploy can run (#46).
- Fill in the privacy policy placeholders and approve it, with the fit finder's privacy wording (#48).
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
- #72 the chart editor's loader and save action (#20)
- #78, #85, #89, #90 display rules: the model, the resolve job, publish triggers, product and collection webhooks (#26, #73, #83, #74)
- #79 the Kiwi storefront scan (#35)
- #81, #87 CSV export and import of Fitted's layout (#33, #75)
- #82 uninstall deletes sessions and resets the plan (#64)
- #84 draft privacy policy and support pages (#47)
- #91 the size guide's app block, popup and size table (#29)
