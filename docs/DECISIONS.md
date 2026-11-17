# Decisions

Dated entries, newest first. Grep for the area you touch; never read front to back.

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
