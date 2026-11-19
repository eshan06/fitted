import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Admin } from "./admin.server";
import { FetchError, safeFetch } from "./fetch.server";
import { scanForKiwi } from "./kiwi-import.server";

vi.mock("./fetch.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetch.server")>()),
  safeFetch: vi.fn(),
}));

const SHOP = "fitted-fixture.myshopify.com";
const HOST = "shop.fitted-fixture.com";
const product = (handle: string) => `https://${HOST}/products/${handle}`;

// Product pages recorded from Kiwi's demo store (kiwi-size-chart-demo, Nov
// 2026), trimmed to Kiwi's markup and the theme around it, with the product
// data replaced. The chart itself is never in the page.
const THEME_HEAD = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Linen shirt</title>
<link href="//${HOST}/cdn/shop/t/7/assets/base.css?v=1" rel="stylesheet" type="text/css" media="all" />`;
const KIWI_EMBED = `<script type="text/javascript" defer src="https://app.kiwisizing.com/web/js/dist/kiwiSizing/plugin/SizingPlugin.prod.js?v=319"></script>`;
const PRODUCT_FORM = `<product-form-component data-section-id="template--1__main" data-product-id="9001">
<form method="post" action="/cart/add"><button type="submit">Add to cart</button></form>
</product-form-component>`;
const KIWI_BLOCK = `<div id="shopify-block-AQ2tpd2lTaXppbmc" class="shopify-block shopify-app-block" data-block-handle="kiwiSizing"><!-- BEGIN app snippet: kiwiSizing --><script>
  window.KiwiSizing = window.KiwiSizing === undefined ? {} : window.KiwiSizing;
  KiwiSizing.shop = "${SHOP}";
  KiwiSizing.data = {
    collections: "411",
    tags: "Shirts,Tops",
    product: "9001",
    metafields: [ ],
    vendor: "Fixture Co",
    type: "",
    title: "Linen shirt",
    images: ["\\/\\/${HOST}\\/cdn\\/shop\\/files\\/shirt.png?v=1"],
    options: [{"name":"Size","position":1,"values":["S","M","L"]}],
    variants: [ {"id": 9101, "title": "S", "available": true} , {"id": 9102, "title": "M", "available": true} ],
    shopCurrency: { moneyWithCurrencyFormat: "\${{amount}} USD", moneyFormat: "\${{amount}}" },
    waitForElementSelector: "",
    waitForElementDelay: 5,
    fallbackToBlockPosition: false,
  };
</script><script type="text/javascript" async src="https://app.kiwisizing.com/web/js/dist/kiwiSizing/plugin/SizingPlugin.prod.js?v=341&shop=${SHOP}" > </script>
<div class="ks-container-app-block"></div>
<!-- END app snippet --></div>`;

const KIWI_PAGE = `${THEME_HEAD}${KIWI_EMBED}</head><body>${PRODUCT_FORM}${KIWI_BLOCK}</body></html>`;
// The block taken off the product template, with Kiwi's app embed still on.
const KIWI_EMBED_ONLY = `${THEME_HEAD}${KIWI_EMBED}</head><body>${PRODUCT_FORM}</body></html>`;
// No Kiwi, though the product and its size guide say "kiwi".
const PLAIN_PAGE = `${THEME_HEAD}</head><body><h1>Kiwi green tee</h1>${PRODUCT_FORM}
<details><summary>Size chart</summary><table><tr><th>Size</th><th>Chest</th></tr><tr><td>S</td><td>36</td></tr></table></details>
</body></html>`;
const PASSWORD_PAGE = `<!doctype html><html><head><title>Opening soon</title></head><body>
<form method="post" action="/password"><input type="password" name="password"><button>Enter</button></form>
</body></html>`;

function shopWith(urls: (string | null)[]) {
  const graphql = vi.fn(async () =>
    Response.json({
      data: {
        shop: { myshopifyDomain: SHOP, primaryDomain: { host: HOST } },
        products: { nodes: urls.map((onlineStoreUrl) => ({ onlineStoreUrl })) },
      },
    }),
  );
  return { graphql } as unknown as Admin;
}

type Page = { html: string; status?: number; finalUrl?: string };
// Serves the recorded pages by URL and notes when each was asked for.
function storefront(pages: Record<string, Page | FetchError>) {
  const asked: number[] = [];
  vi.mocked(safeFetch).mockImplementation(async (link) => {
    asked.push(Date.now());
    const page = pages[link];
    if (!page) throw new Error(`Fetched an unexpected page: ${link}`);
    if (page instanceof FetchError) throw page;
    return {
      url: page.finalUrl ?? link,
      status: page.status ?? 200,
      body: Buffer.from(page.html),
    };
  });
  return asked;
}

// Plays the scan's half-second gaps out on fake timers.
async function scan(admin: Admin) {
  const outcome = scanForKiwi(admin).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const done = await outcome;
  if ("error" in done) throw done.error;
  return done.value;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("scanForKiwi", () => {
  it("finds Kiwi's app block, whose charts it can't read", async () => {
    storefront({ [product("shirt")]: { html: KIWI_PAGE } });
    expect(await scan(shopWith([product("shirt")]))).toBe("kiwi_unreadable");
  });

  it("finds Kiwi from its script when the product page has no block", async () => {
    storefront({ [product("shirt")]: { html: KIWI_EMBED_ONLY } });
    expect(await scan(shopWith([product("shirt")]))).toBe("kiwi_unreadable");
  });

  it.each([
    ["its block", `<div data-block-handle="kiwiSizing"></div>`],
    ["its product data", `<script>KiwiSizing.data = {};</script>`],
    ["its script", KIWI_EMBED],
    [
      "its script's address escaped in a JSON string",
      `<script>var urls = ["https:\\/\\/app.kiwisizing.com\\/web\\/js\\/dist\\/kiwiSizing\\/plugin\\/SizingPlugin.prod.js?v=341"];</script>`,
    ],
  ])("knows Kiwi by %s alone", async (_, marker) => {
    const html = PLAIN_PAGE.replace("</body>", `${marker}</body>`);
    storefront({ [product("shirt")]: { html } });
    expect(await scan(shopWith([product("shirt")]))).toBe("kiwi_unreadable");
  });

  it("finds nothing in a shop without Kiwi, after at most 5 pages", async () => {
    const urls = ["a", "b", "c", "d", "e", "f"].map(product);
    storefront(Object.fromEntries(urls.map((u) => [u, { html: PLAIN_PAGE }])));
    expect(await scan(shopWith([null, ...urls]))).toBe("no_kiwi");
    expect(vi.mocked(safeFetch).mock.calls.map(([url]) => url)).toEqual(
      urls.slice(0, 5),
    );
  });

  it("reads only the shop's own domains, at most 2 pages a second", async () => {
    const urls = ["a", "b", "c"].map(product);
    const asked = storefront(
      Object.fromEntries(urls.map((u) => [u, { html: PLAIN_PAGE }])),
    );
    expect(await scan(shopWith(urls))).toBe("no_kiwi");
    for (const [, options] of vi.mocked(safeFetch).mock.calls)
      expect(options).toEqual({ allowHosts: [SHOP, HOST] });
    expect(asked.slice(1).map((t, i) => t - asked[i])).toEqual([500, 500]);
  });

  it("stops at Kiwi without reading the remaining pages", async () => {
    storefront({
      [product("a")]: { html: PLAIN_PAGE },
      [product("b")]: { html: KIWI_PAGE },
    });
    const admin = shopWith(["a", "b", "c"].map(product));
    expect(await scan(admin)).toBe("kiwi_unreadable");
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it("reports a password-protected storefront", async () => {
    storefront({
      [product("shirt")]: {
        html: PASSWORD_PAGE,
        finalUrl: `https://${HOST}/password`,
      },
    });
    expect(await scan(shopWith([product("shirt")]))).toBe("password");
  });

  it("reports a shop with nothing on the Online Store, without fetching", async () => {
    expect(await scan(shopWith([null, null]))).toBe("no_products");
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("skips a product taken off the storefront since the list was read", async () => {
    storefront({
      [product("gone")]: { html: "Not found", status: 404 },
      [product("shirt")]: { html: KIWI_PAGE },
    });
    const admin = shopWith([product("gone"), product("shirt")]);
    expect(await scan(admin)).toBe("kiwi_unreadable");
  });

  it("fails, for the job to offer Try again, when the storefront can't be read", async () => {
    const admin = shopWith([product("shirt")]);
    storefront({ [product("shirt")]: { html: "Busy", status: 503 } });
    await expect(scan(admin)).rejects.toMatchObject({ reason: "failed" });
    storefront({ [product("shirt")]: new FetchError("timeout", "No answer") });
    await expect(scan(admin)).rejects.toMatchObject({ reason: "timeout" });
  });
});
