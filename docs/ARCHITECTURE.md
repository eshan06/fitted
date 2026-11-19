# Architecture

The design every step builds against. Read this index, then only the sections your work touches, and cite them by number ("ARCHITECTURE §5"). Sections 5 to 13 live in `docs/arch/`, keep their numbers, and bind like this file. A section marked "confirm in #n" names a detail that step checks on the dev store and then records here. When a file passes about 5,000 words, split it further.

1. Stack: Shopify's React Router app template, TypeScript, Node 22, npm.
2. Admin app: the embedded screens and their routes.
3. Auth and sessions: `app/shopify.server.ts`, scopes, staff names.
4. Where data lives: the merchant's store, the app database, and what uninstalling does.
5. Size chart: the `$app:chart` metaobject and its JSON. `docs/arch/data.md`
6. Display rules: how a product finds its chart. `docs/arch/data.md`
7. Settings and plan metafields: what the storefront reads besides charts. `docs/arch/data.md`
8. Plans and gating: Free, Standard, Pro, read from the Partner API. `docs/arch/data.md`
9. Storefront: the theme app extension. `docs/arch/storefront.md`
10. Fit finder: the shared engine; answers stay in the browser. `docs/arch/storefront.md`
11. Translations: how chart words reach every store language. `docs/arch/storefront.md`
12. Events and stats: the app proxy endpoint. `docs/arch/storefront.md`
13. Import: sources, drafts, jobs, OpenAI, fetch safety. `docs/arch/import.md`
14. App database: Postgres tables on Railway.
15. Errors and retries: the conventions every route follows.
16. Webhooks: every subscription and its handler.
17. Hosting and environment: Railway and env vars.
18. Pipeline: CI, review and size gates in `.github/`, agent rules in `.claude/`.

## 1. Stack

Scaffolded from Shopify's React Router template (commit 9597d08): React Router 7 with Vite, `@shopify/shopify-app-react-router`, App Bridge, Polaris web components, Prisma. Tests run on Vitest (`app/**/*.test.ts(x)`). `shopify.app.toml` holds the app's Shopify config (client ID, scopes, webhooks, metafield and metaobject definitions, app proxy); `shopify.web.toml` tells the Shopify CLI how to run it. Server-only modules end in `.server.ts` and live in `app/models/`; code shared with the storefront lives in `app/lib/` and imports nothing from server code (§9).

## 2. Admin app

`app/routes/app.tsx` authenticates every admin request (`authenticate.admin`) and renders the App Bridge shell with Fitted's navigation, in this order: Home (`app._index.tsx`), Size charts (`app.charts._index.tsx`, with `app.charts.new.tsx` for the template picker and `app.charts.$id.tsx` for the editor), Import (`app.import.tsx`), Display rules (`app.rules.tsx`), Fit finder (`app.fit-finder.tsx`), Appearance & languages (`app.appearance.tsx`). CSV export is `app.export.tsx`. Outside the admin, `privacy.tsx` and `support.tsx` are public pages (`/privacy`, `/support`) with no loader, so they never read a shop's data; the privacy policy describes §4, §10, §12, §13 and §14, so a change to what Fitted stores, sends or keeps updates it in the same PR.

Screens read and write through `app/models/*.server.ts` (charts, rules, settings, billing, stats, imports), never with GraphQL inline in a route. Whether the size guide's app embed is on (Home's setup guide) comes from App Bridge `shopify.app.extensions()` in the browser, which needs no extra scope.

States these contracts add that the canvas doesn't draw yet get drawn before they're built: the shareable chart page (§5), the translation Review screen and Translate stopping at its budget (§11), the plan-check banner (§8), the staff-without-access message (§15), Display rules' "rules didn't finish applying" (§13), and Home noting a day that hit the event cap (§12).

## 3. Auth and sessions

`app/shopify.server.ts` configures `shopifyApp`: Admin API version July 2026, App Store distribution, expiring offline tokens, and `PrismaSessionStorage`. OAuth runs through `app/routes/auth.$.tsx`. Every loader and action that touches shop data calls `authenticate.admin` (or `authenticate.webhook` / `authenticate.public.appProxy`) and uses only that session's shop. Background work (webhooks, jobs) uses `unauthenticated.admin(shop)` with the shop from a verified webhook or from the job row, never from a browser.

Staff names: the charts list and version history show who saved ("Priya N."). The first step that records an editor (#24) turns on `useOnlineTokens: true` and reads `session.onlineAccessInfo.associated_user`; version rows keep only first name plus last initial. From then on the `Session` table also holds one online session per staff member who opens Fitted, with the name and email Shopify sends (§14), and admin calls run with that staff member's permissions, so every screen handles a 403 for staff without access (§15). Offline tokens keep serving background work.

Scopes, added by the step that first needs each: `write_products`, `write_metaobjects`, `write_metaobject_definitions` (already set); `read_locales` (#28, the primary locale for `settings.text`); `write_files` (#22, How to measure images); `write_app_proxy` (#24, the Copy link page, then #44's events); `write_translations` (#43). Nothing else without updating this list.

## 4. Where data lives

| Data                                                            | Where                                 | Section |
| --------------------------------------------------------------- | ------------------------------------- | ------- |
| Charts                                                          | Metaobjects of type `$app:chart`      | §5      |
| Which chart a product shows                                     | Product metafield `$app.chart`        | §6      |
| Display rules                                                   | Shop metafield `$app.rules` (json)    | §6      |
| Appearance, units, placement, fit finder settings, custom texts | Shop metafield `$app.settings` (json) | §7      |
| The plan, for the storefront                                    | Shop metafield `$app.plan`            | §7      |
| How to measure images, uploaded fonts                           | Shopify Files                         | §5, §7  |
| Sessions, plan cache, versions, jobs, events, AI usage          | Postgres                              | §14     |

All definitions are app-owned and declared in `shopify.app.toml` (`[metaobjects.app.chart]`, `[product.metafields.app.chart]`, `[shop.metafields.app.settings]`, and so on); code reads them as type `$app:chart` and namespace `$app`, never a bare `app`; Liquid outside the extension, where `$app` doesn't resolve, uses `app--<app id>` (§5). Admin access stays `merchant_read`: merchants can see everything in their Shopify admin, but only Fitted writes values, so every write passes Fitted's validation. Translations are the exception: any app with `write_translations` can register them, so the storefront re-validates what it reads (§9).

Uninstalling: Shopify deletes app-owned definitions at uninstall and keeps the values only temporarily, with no guaranteed period. So charts live in the merchant's store while Fitted is installed, and CSV export on every plan (#33) is the way to take them elsewhere. Copy must not promise that charts outlive an uninstall. Reinstalling before Shopify's cleanup brings them back.

## 14. App database

Postgres 18 on Railway (#8, `DATABASE_URL`), and the same version locally from `docker-compose.yml` (README). Prisma migrations are applied by `npm run setup` (`prisma migrate deploy`) on Railway and by `npm run dev` locally. Each table arrives with the first step that needs it, with a migration made by `npx prisma migrate dev --name <change>` against the local Postgres. CI applies every migration to Postgres 18, fails when `schema.prisma` has no matching migration, and runs the database tests (`app/db.server.test.ts`) there.

| Table          | Holds                                                                                                                     | Step     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | -------- |
| `Session`      | The template's sessions: offline, plus online ones with the staff member's name and email from #24 (§3)                   | exists   |
| `Shop`         | `shop` (key), `plan`, `planCheckedAt`, `planOnStore` (last value written to `$app.plan`), `resolvedAt`                    | #17      |
| `ChartVersion` | `shop`, `chartId`, `createdAt`, `by` (display name or source), `summary`, `snapshot` (json)                               | #24      |
| `Job`          | `shop`, `kind` (`import` or `resolve`), `status` (`running`, `done`, `failed`), `progress`, `result`, `error`, timestamps | #73, #34 |
| `Event`        | `shop`, `id`, `type`, `chartId`, `productId`, `size`, `createdAt`; unique on `(shop, id)`                                 | #44      |
| `AiUsage`      | `shop`, `day`, `count`; key `(shop, day)`                                                                                 | #38      |

Every query filters on the session's shop, and an id sent by a browser is looked up within that shop. Version snapshots are app-only copies kept for history; the live chart stays in the store. `app/uninstalled` deletes the shop's sessions on every delivery it handles, with or without a session from the library, and resets its cached plan to Free (§8); `shop/redact` deletes every row for the shop in every table; `customers/data_request` and `customers/redact` only acknowledge, because Fitted stores no shopper data. Retention: events 90 days, AI usage 30 days, versions the last 30 per chart, jobs as in §13, and expired online sessions deleted whenever a shop stores a new one (#24). The privacy policy (#47) lists the staff names and emails in `Session`.

## 15. Errors and retries

- Every failure shows the canvas's light red banner: what failed, what didn't change, Try again. Raw error text from Shopify or OpenAI is logged, never shown.
- Loaders and actions: a failed Shopify call returns status 502 with `{ error: { code, message } }`, and the screen shows its error state. A loader that streams its data (`Await`) so the screen can draw its loading state has already sent its 200, so the stream resolves to that same `{ error }` body instead. Validation returns 422 with `{ fieldErrors: { "<path>": "<message>" } }`. A stale save returns 409 (§5, §6), a plan gate 403 with the upgrade path, a staff member without access 403 saying so, a rate limit 429. 401 and 404 are thrown Responses.
- Admin API: every mutation checks `userErrors`; one helper in `app/models/admin.server.ts` (added by #59) throws on GraphQL errors or user errors. Reads may retry twice with backoff. Writes retry only when they're idempotent, as `metaobjectUpsert` and `metafieldsSet` are. A retried `metafieldsSet` that comes back stale on its `compareDigest` counts as success when the stored value already equals what was sent (the first attempt landed).
- Partial success is reported per item (an import's "2 of 11 charts didn't import"), never as all-or-nothing.
- Webhooks return 200 once handled and 500 when they failed, so Shopify retries; handlers are idempotent. A signed payload without the fields a handler needs gets 400, with no call to Shopify.
- Storefront: bad or missing data renders nothing; a failed script load shows the guide's error state with Try again.
- Logs: JSON lines to stdout (`level`, `msg`, `shop`, `route`). Never tokens, uploaded files, shopper data, staff names or emails, or env values.

## 16. Webhooks

Subscribed in `shopify.app.toml`, handled in `app/routes/webhooks.*` (§3):

| Topic                                        | Does                                                      | Step   |
| -------------------------------------------- | --------------------------------------------------------- | ------ |
| `app/uninstalled`                            | Deletes the shop's sessions; resets its plan to Free (§8) | exists |
| `app/scopes_update`                          | Updates the session's scopes                              | exists |
| `customers/data_request`, `customers/redact` | Acknowledge (no shopper data stored)                      | #16    |
| `shop/redact`                                | Deletes every app database row for the shop               | #16    |
| `products/create`, `products/update`         | Resolve that product's chart (§6)                         | #74    |
| `collections/update`, `collections/delete`   | A full resolve when a rule names the collection (§6)      | #74    |

The template's demo `products/update` event subscription is removed in #13. Since #64, uninstalling deletes the shop's sessions and resets its cached plan to Free. App Pricing sends no billing webhooks (§8).

## 17. Hosting and environment

Railway project "Fitted", production environment: one app service (#46) and the Postgres database (#8). One instance only: jobs and the event rate limiter live in its memory. `shopify app deploy` ships the app config and the extension.

Env vars, set on the Railway app service and in local `.env`, never committed: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `DATABASE_URL`, `OPENAI_API_KEY` (a Railway shared variable, referenced as `${{shared.OPENAI_API_KEY}}`), and for the Partner API (§8) `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_ACCESS_TOKEN` and `SHOPIFY_APP_GID`. `.env.example` lists them without values; a `!.env.example` line keeps `.gitignore`'s `.env.*` from hiding it.

## 18. Pipeline

`.github/workflows/`: `ci.yml` (typecheck, lint, format, tests, build, script self-tests and word caps behind one `CI gate` job), `size.yml`, `claude-review.yml` (holds the only copy of the blocker rules), `attribution.yml`, `docs-cap.yml`. Size, Attribution and Claude Review use `pull_request_target`: main's copy of the workflow, a checkout of main, and the PR read only as git objects, so a PR can't edit those gates (it could still add a decoy workflow with the same check name; see GOTCHAS). CI uses `pull_request` and runs the PR's code. The review's OAuth token sits in the `claude-review` environment, which only main can use. `.claude/`: the worker and reviewer agents, `/plan` and `/santa-loop`, careful paths, and settings (dependency hook, deny rules). Shared scripts live in `scripts/`. Steps are GitHub issues in the "Fitted v1" milestone and board; workers run as separate sessions and coordinate on those issues.
