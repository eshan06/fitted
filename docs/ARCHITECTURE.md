# Architecture

The design as it is now. Read this index, then only the sections your work touches. Past about 5,000 words, split into docs/arch/<area>.md.

1. Stack: Shopify's React Router app template, TypeScript, Node 22, npm.
2. Admin app: embedded in Shopify admin; routes under `app/routes/app.*`.
3. Auth and sessions: `app/shopify.server.ts`; sessions in the app database.
4. Data: the merchant's store holds merchant data; the app database holds sessions.
5. Webhooks: `app/routes/webhooks.*`, subscribed in `shopify.app.toml`.
6. Storefront: the shopper's size guide, a theme app extension (not built yet).
7. Billing: Shopify App Pricing (not built yet).
8. Hosting: Railway (not set up yet).
9. Pipeline: CI, review and size gates in `.github/`, agent rules in `.claude/`.

## 1. Stack

Scaffolded from Shopify's React Router template (commit 9597d08): React Router 7 with Vite, `@shopify/shopify-app-react-router`, App Bridge, Polaris web components, Prisma. Tests run on Vitest (`app/**/*.test.ts(x)`). `shopify.app.toml` holds the app's Shopify config (client ID, scopes, webhooks); `shopify.web.toml` tells the Shopify CLI how to run it.

## 2. Admin app

`app/routes/app.tsx` authenticates every admin request (`authenticate.admin`) and renders the App Bridge shell. Child routes are the screens. The template's demo screens (`app._index.tsx`, `app.additional.tsx`) are placeholders until the Fitted screens replace them.

## 3. Auth and sessions

`app/shopify.server.ts` configures `shopifyApp`: Admin API version July 2026, App Store distribution, expiring offline tokens, and `PrismaSessionStorage`. OAuth runs through `app/routes/auth.$.tsx`. Every loader and action that touches shop data calls `authenticate.admin` (or the webhook/proxy equivalent) and uses only that session's shop.

## 4. Data

Merchant-facing data belongs to the merchant's store: charts as metaobjects, per-product settings as metafields, so uninstalling Fitted never strands a merchant's charts. The app database (Prisma; SQLite in development, `prisma/dev.sqlite`) holds the `Session` table only. The template's demo metafield and metaobject definitions in `shopify.app.toml` are placeholders.

## 5. Webhooks

Subscribed in `shopify.app.toml`, handled in `app/routes/webhooks.*`: `app/uninstalled` (deletes the shop's sessions), `app/scopes_update`, and the template's demo `products/update`. Shopify's three mandatory privacy webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) are not wired yet; App Store review requires them.

## 6. Storefront

Not built. The size guide will be a theme app extension under `extensions/`, so it renders inside each merchant's theme and needs no script injection.

## 7. Billing

Not built. Plans are set in Shopify App Pricing (the merchant pays on their Shopify bill); the app reads the active plan to gate features.

## 8. Hosting

Not set up. Railway is the target for the app server and its production database.

## 9. Pipeline

`.github/workflows/`: `ci.yml` (typecheck, lint, format, tests, build, script self-tests and word caps behind one `CI gate` job), `size.yml`, `claude-review.yml` (holds the only copy of the blocker rules), `attribution.yml`, `docs-cap.yml`. Size, Attribution and Claude Review use `pull_request_target`: main's copy of the workflow, a checkout of main, and the PR read only as git objects, so a PR can't edit those gates (it could still add a decoy workflow with the same check name; see GOTCHAS). CI uses `pull_request` and runs the PR's code. The review's OAuth token sits in the `claude-review` environment, which only main can use. `.claude/`: the worker and reviewer agents, `/plan` and `/santa-loop`, careful paths, and settings (dependency hook, deny rules). Shared scripts live in `scripts/`. Steps are GitHub issues in the "Fitted v1" milestone and board; workers run as separate sessions and coordinate on those issues.
