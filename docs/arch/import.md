# Architecture: import

Part of docs/ARCHITECTURE.md (§13); its rules bind the same way.

## 13. Import

Every source produces the same `ChartDraft`: a chart's `name`, `template` and `content` (§5), plus the products it was on, a status of `ready`, `check_units` or `unreadable`, and a plain reason for anything not ready. Drafts go through the chart validator like any other write.

| Source               | Step     | Reads                                           |
| -------------------- | -------- | ----------------------------------------------- |
| Kiwi Size Chart      | #35, #36 | The session shop's own storefront product pages |
| CSV                  | #33      | Fitted's CSV template or a spreadsheet export   |
| Product descriptions | #37      | `descriptionHtml` from the Admin API            |
| Image, PDF           | #38      | An upload, read by OpenAI                       |
| Web page, Word       | #39      | A pasted link, or a .docx upload                |

Flow (#34): Find charts starts an `import` job (below). The review screen lists the drafts; Fix resolves `check_units`; Import creates the selected drafts as Draft charts with the handles of §5, so Try again re-runs only the failed ones and never duplicates. Their product assignments become `product` conditions (§6), reported per chart when they don't fit the id limit. Nothing goes live until the merchant publishes. A version row records "Imported from Kiwi" or the source.

Jobs: imports and full rule resolves run as `Job` rows (§14) inside the app process, at most one running job per shop and kind, with progress saved as it goes, so a stopped scan offers the charts found so far. A job with no progress for 10 minutes is marked failed; at server start that check also runs, so a job the old instance is still finishing during a deploy is left alone. A failed import is the merchant's to scan again; a failed resolve is requeued at server start, since resolves are idempotent and merchants never start them. The newest finished job per shop and kind is kept (Home's setup guide reads it); others go after 7 days. `ponytail:` in-process jobs assume one Railway instance; move to a queue before running two.

Limits and safety:

- Uploads: CSV up to 1 MB, images (PNG, JPG, WebP) up to 10 MB, PDFs up to 20 MB and 10 pages, .docx up to 5 MB. The type is checked by the file's first bytes, not its name. A .docx is read entry by entry with inflated bytes counted, and refused past 20 MB inflated in total. Files are processed in memory and never stored.
- Fetching: Kiwi and web-link reads go through one fetch helper. It allows http and https on ports 80 and 443 only. It checks the address actually dialed, at connect time, on every redirect, so DNS rebinding can't slip past. It refuses loopback, private, link-local, carrier-grade NAT (100.64.0.0/10), unique-local IPv6 (fc00::/7), IPv4-mapped IPv6, 0.0.0.0, `::` and metadata addresses. It has a 10-second timeout, and its 5 MB cap counts bytes after decompression. URLs found inside imported content (an image in a description) go through it too.
- Kiwi (#6 limits): only after the merchant clicks Find charts; only the session shop's `myshopify.com` domain and its `primaryDomain` from the Admin API, through the fetch helper; at most 2 requests a second; numbers and text only, no Kiwi images, logos or styling. A shop without Kiwi, or with a password-protected storefront, gets the "nothing found" state with its reason. #35 and #36 test found charts with recorded storefront fixtures. Re-check Kiwi's terms before launch.
- OpenAI: image and PDF import and translations go through one module, `app/models/openai.server.ts`, with `OPENAI_API_KEY`, the model name and an output-token cap in constants, structured JSON output, and a 60-second timeout. The model's answer is untrusted input: it is validated like any draft. Calls count against a shop budget of 100 a day and an app-wide budget of 1,000 a day (`AiUsage`, §14). Past either, or when OpenAI refuses for quota (the organization has a hard $5 monthly cap for now), the merchant is told plainly and offered CSV.

CSV (#33): one row per size row; #33 records the exact columns here. Export covers every chart on every plan; sizes, columns, values, units and notes survive a round trip unchanged, and a bad file gets row-level errors.
