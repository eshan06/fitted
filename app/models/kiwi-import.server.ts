// The Kiwi Size Chart scan (ARCHITECTURE §13, the #6 limits). Only the import
// job the merchant starts with Find charts calls it; it reads only the shop's
// own storefront, through safeFetch, at most 2 pages a second.
//
// What Kiwi puts in a product page (checked on Kiwi's demo store, #35): its
// app block prints `KiwiSizing.data` (the product's id, tags, collections and
// options) and loads SizingPlugin from app.kiwisizing.com, which fetches the
// chart from Kiwi's own server in the shopper's browser. No chart number or
// word is ever in the page, so the scan can only say why nothing was found.
import { type Admin, adminGraphql } from "./admin.server";
import { FetchError, safeFetch } from "./fetch.server";

export type KiwiScan =
  | "no_products" // nothing published on the Online Store to read
  | "password" // the storefront is password-protected
  | "no_kiwi"
  | "kiwi_unreadable"; // Kiwi is there; its charts live on Kiwi's server

// Kiwi's app block, its inline data, or its plugin script, escaped or not.
const KIWI =
  /data-block-handle="kiwiSizing"|KiwiSizing\.data\s*=|kiwisizing\.com[^"'\s<>]{0,200}SizingPlugin/;
// ponytail: samples 5 product pages, enough to see Kiwi's script; walk every
// product if Kiwi ever puts charts in the page.
const PAGES = 5;
const GAP_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Throws FetchError when the storefront can't be read; the job shows Try
// again.
export async function scanForKiwi(admin: Admin): Promise<KiwiScan> {
  const { shop, products } = await adminGraphql<{
    shop: { myshopifyDomain: string; primaryDomain: { host: string } };
    products: { nodes: { onlineStoreUrl: string | null }[] };
  }>(
    admin,
    `#graphql
    query KiwiScan {
      shop { myshopifyDomain primaryDomain { host } }
      products(first: 25, query: "status:active") { nodes { onlineStoreUrl } }
    }`,
    {},
    { retry: true },
  );
  const urls = products.nodes
    .flatMap((p) => p.onlineStoreUrl ?? [])
    .slice(0, PAGES);
  if (!urls.length) return "no_products";
  const allowHosts = [shop.myshopifyDomain, shop.primaryDomain.host];
  for (const [i, url] of urls.entries()) {
    if (i) await sleep(GAP_MS);
    const page = await safeFetch(url, { allowHosts });
    if (new URL(page.url).pathname.endsWith("/password")) return "password";
    if (page.status === 404) continue; // unpublished since the list was read
    if (page.status !== 200)
      throw new FetchError("failed", `The storefront answered ${page.status}`);
    if (KIWI.test(page.body.toString("utf8"))) return "kiwi_unreadable";
  }
  return "no_kiwi";
}
