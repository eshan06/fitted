import { describe, expect, it, vi } from "vitest";
import {
  SettingsConflictError,
  SettingsReadWriteError,
  SettingsValidationError,
  defaultSettings,
  fillDefaults,
  getSettings,
  saveSettings,
  validateSettings,
} from "./settings.server";
import type { Settings } from "./settings.server";

const shopId = "gid://shopify/Shop/5678";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

// A store with one `$app.settings` metafield, enforcing compareDigest like Shopify.
function fakeStore(locales = [{ locale: "en", primary: true }]) {
  let stored: { value: string; digest: string } | null = null;
  let n = 0;
  const graphql = vi.fn(
    async (
      query: string,
      options?: { variables?: Record<string, unknown>; signal?: AbortSignal },
    ) => {
      if (query.includes("query FittedSettings"))
        return json({
          data: {
            shop: {
              id: shopId,
              metafield: stored && {
                jsonValue: JSON.parse(stored.value),
                compareDigest: stored.digest,
              },
            },
            shopLocales: locales,
          },
        });
      const [input] = options!.variables!.metafields as {
        ownerId: string;
        namespace: string;
        key: string;
        type: string;
        value: string;
        compareDigest: string | null;
      }[];
      expect(input).toMatchObject({
        ownerId: shopId,
        namespace: "$app",
        key: "settings",
        type: "json",
      });
      if (input.compareDigest !== (stored?.digest ?? null))
        return json({
          data: {
            metafieldsSet: {
              metafields: [],
              userErrors: [
                {
                  field: ["metafields", "0"],
                  message: "Stale",
                  code: "STALE_OBJECT",
                },
              ],
            },
          },
        });
      stored = { value: input.value, digest: `digest-${++n}` };
      return json({
        data: {
          metafieldsSet: {
            metafields: [{ compareDigest: stored.digest }],
            userErrors: [],
          },
        },
      });
    },
  );
  return { admin: { graphql }, graphql, stored: () => stored };
}

const custom = (): Settings => ({
  ...defaultSettings("en"),
  link: { style: "button", icon: "hanger" },
  popup: {
    style: "drawer",
    sheetOnPhone: false,
    openFrom: "right",
    font: { fileUrl: "https://cdn.shopify.com/s/files/1/0001/font.woff2?v=1" },
    logo: false,
    sticky: false,
    rtl: true,
    fitOnly: true,
  },
  placement: {
    productBlock: false,
    quickView: true,
    floatingTab: true,
    featured: true,
    selector: ".product-form__input--size",
  },
  colors: {
    mode: "custom",
    text: "#202223",
    accent: "#2448a8",
    background: "#FFFFFF",
  },
  units: { default: "cm", toggle: false },
  css: ".fitted-link { text-decoration: underline; }",
  text: {
    en: { label: "Fit guide", header: "Find your fit", noFit: "No match." },
    fr: { label: "Guide des tailles", header: "Tailles", noFit: "Aucune." },
  },
});

describe("saving and reading settings", () => {
  it("reads defaults, with a null digest, before the first save", async () => {
    const { admin } = fakeStore([
      { locale: "fr", primary: false },
      { locale: "en", primary: true },
    ]);
    await expect(getSettings(admin)).resolves.toEqual({
      settings: defaultSettings("en"),
      digest: null,
      shopId,
      primaryLocale: "en",
    });
  });

  it("saves to the shop and reads back exactly", async () => {
    const store = fakeStore();
    const first = await getSettings(store.admin);
    const digest = await saveSettings(store.admin, first, custom());

    const again = await getSettings(store.admin);
    expect(again.settings).toEqual(custom());
    expect(again.digest).toBe(digest);
    expect(JSON.parse(store.stored()!.value)).toEqual(custom());
  });

  it("refuses a save over a newer one with a conflict", async () => {
    const store = fakeStore();
    const tabA = await getSettings(store.admin);
    const tabB = await getSettings(store.admin);
    await saveSettings(store.admin, tabA, custom());

    await expect(
      saveSettings(store.admin, tabB, defaultSettings("en")),
    ).rejects.toBeInstanceOf(SettingsConflictError);
    expect(JSON.parse(store.stored()!.value)).toEqual(custom());
  });

  it("treats a digest Shopify calls invalid as a conflict", async () => {
    const graphql = vi.fn(async () =>
      json({
        data: {
          metafieldsSet: {
            metafields: [],
            userErrors: [
              {
                field: null,
                message: "Bad digest",
                code: "INVALID_COMPARE_DIGEST",
              },
            ],
          },
        },
      }),
    );
    await expect(
      saveSettings(
        { graphql },
        { shopId, primaryLocale: "en", digest: "junk" },
        custom(),
      ),
    ).rejects.toBeInstanceOf(SettingsConflictError);
  });

  it("never writes invalid settings", async () => {
    const store = fakeStore();
    const loaded = await getSettings(store.admin);
    await expect(
      saveSettings(store.admin, loaded, { ...custom(), css: "</style>" }),
    ).rejects.toBeInstanceOf(SettingsValidationError);
    expect(store.graphql).toHaveBeenCalledTimes(1); // only the read
  });

  it.each([
    ["an HTTP error", () => json({ errors: "Internal" }, 500)],
    ["GraphQL errors", () => json({ errors: [{ message: "Throttled" }] })],
    ["an unreadable body", () => new Response("<html>", { status: 200 })],
    [
      "no primary locale",
      () =>
        json({
          data: { shop: { id: shopId, metafield: null }, shopLocales: [] },
        }),
    ],
    [
      "no shop id",
      () =>
        json({
          data: {
            shop: { metafield: null },
            shopLocales: [{ locale: "en", primary: true }],
          },
        }),
    ],
    [
      "a thrown network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("reports %s on read as a read/write error", async (_, reply) => {
    const graphql = vi.fn(async () => reply());
    await expect(getSettings({ graphql })).rejects.toBeInstanceOf(
      SettingsReadWriteError,
    );
  });

  it("gives every call a timeout", async () => {
    const store = fakeStore();
    await saveSettings(store.admin, await getSettings(store.admin), custom());
    for (const [, options] of store.graphql.mock.calls)
      expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["no userErrors", { metafieldsSet: { metafields: [] } }],
    ["no digest back", { metafieldsSet: { metafields: [], userErrors: [] } }],
  ])("reports a save with %s as a read/write error", async (_, data) => {
    const graphql = vi.fn(async () => json({ data }));
    await expect(
      saveSettings(
        { graphql },
        { shopId, primaryLocale: "en", digest: null },
        custom(),
      ),
    ).rejects.toBeInstanceOf(SettingsReadWriteError);
  });

  it("reports other user errors on save as a read/write error", async () => {
    const graphql = vi.fn(async () =>
      json({
        data: {
          metafieldsSet: {
            metafields: [],
            userErrors: [
              {
                field: ["metafields", "0", "value"],
                message: "Too big",
                code: "INVALID_VALUE",
              },
            ],
          },
        },
      }),
    );
    await expect(
      saveSettings(
        { graphql },
        { shopId, primaryLocale: "en", digest: null },
        custom(),
      ),
    ).rejects.toBeInstanceOf(SettingsReadWriteError);
  });

  it("lets a thrown Response (re-auth) through", async () => {
    const reauth = new Response(null, { status: 401 });
    const graphql = vi.fn(async () => {
      throw reauth;
    });
    await expect(getSettings({ graphql })).rejects.toBe(reauth);
  });
});

describe("validateSettings", () => {
  const errors = (input: unknown, locale = "en") => {
    try {
      validateSettings(input, locale);
      return {};
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsValidationError);
      return (error as SettingsValidationError).fieldErrors;
    }
  };
  const withField = (path: string, value: unknown) => {
    const s = custom() as unknown as Record<string, Record<string, unknown>>;
    const [section, field] = path.split(".");
    if (field) s[section] = { ...s[section], [field]: value };
    else (s as Record<string, unknown>)[section] = value;
    return s;
  };

  it("accepts the defaults and a fully custom document", () => {
    expect(errors(defaultSettings("en"))).toEqual({});
    expect(errors(custom())).toEqual({});
    expect(errors({ ...custom(), colors: { mode: "theme" } })).toEqual({});
    const files =
      '.fitted-dialog{background:url(https://cdn.shopify.com/s/files/1/bg.png?v=2)} .fitted-x{background:URL( "https://cdn.shopify.com/x.svg" )}';
    expect(errors({ ...custom(), css: files })).toEqual({});
  });

  it.each([
    ["link.style", "tab-ish"],
    ["link.icon", "star"],
    ["popup.style", "modal"],
    ["popup.sticky", "yes"],
    ["popup.openFrom", "top"],
    ["popup.font", "comic-sans"],
    ["popup.font", { fileUrl: "https://evil.example/font.woff2" }],
    ["popup.font", { fileUrl: "https://cdn.shopify.com/a.woff2);x:url(" }],
    ["popup.font", { fileUrl: "https://cdn.shopify.com/a b.woff2" }],
    ["popup.font", { fileUrl: "https://cdn.shopify.com/a.woff2", extra: 1 }],
    ["placement.selector", "x".repeat(201)],
    ["placement.selector", "div\n.size"],
    ["placement.featured", null],
    ["units.default", "mm"],
    ["fitFinder.type", "magic"],
    ["fitFinder.answers", "dial"],
    ["fitFinder.askAge", 1],
    ["css", "body { background: red } </style><script>"],
    ["css", "a{}".repeat(3500)],
    ["css", "é".repeat(5200)], // under 10K characters, over 10 KB
    ["css", 42],
    // It loads nothing but Shopify Files, and no escape hides that.
    ["css", '@import "https://evil.example/x.css";'],
    ["css", "@IMPORT url(https://cdn.shopify.com/x.css);"],
    ["css", ".fitted-link{background:url(https://evil.example/t.gif)}"],
    ["css", ".fitted-link{background:url( '//evil.example/t.gif' )}"],
    [
      "css",
      ".fitted-link{background:url(https://cdn.shopify.com.evil.example/t)}",
    ],
    [
      "css",
      ".fitted-link{background:url(https://cdn.shopify.com@evil.example/)}",
    ],
    ["css", '.fitted-link{background:image-set("https://evil.example/t" 1x)}'],
    ["css", '.fitted-link{background:src("https://evil.example/t")}'],
    [
      "css",
      '.fitted-link{background:filter("https://evil.example/t", blur(1px))}',
    ],
    // Shopify Files only through plain url(), so image-set() is refused too.
    [
      "css",
      ".fitted-link{background:image-set(url(https://cdn.shopify.com/a.png) 1x)}",
    ],
    ["css", ".fitted-link{background:u\\72l(https://evil.example/t)}"],
    ["css", '.fitted-link::after{content:"\\201C"}'],
    ["v", 2],
  ])("refuses %s = %j", (path, value) => {
    expect(errors(withField(path, value))).toHaveProperty([path]);
  });

  it.each([
    [
      { mode: "custom", text: "red", accent: "#000000", background: "#ffffff" },
      "colors.text",
    ],
    [
      { mode: "custom", text: "#000000", accent: "#000000" },
      "colors.background",
    ],
    [{ mode: "theme", text: "#000000" }, "colors.text"],
    [{ mode: "dark" }, "colors.mode"],
  ])("refuses colors %j", (colors, path) => {
    expect(errors({ ...custom(), colors })).toHaveProperty([path]);
  });

  it("refuses unknown and missing fields", () => {
    expect(errors({ ...custom(), units: undefined })).toHaveProperty(["units"]);
    expect(errors({ ...custom(), extra: true })).toHaveProperty(["extra"]);
    expect(errors(withField("link.color", "#000000"))).toHaveProperty([
      "link.color",
    ]);
    expect(errors(null)).toHaveProperty([""]);
  });

  it("requires the primary locale's words and checks every language", () => {
    expect(errors(custom(), "de")).toHaveProperty(["text.de"]);
    const text = (t: unknown) => ({ ...custom(), text: { en: t } });
    const ok = { label: "Size guide", header: "Size guide", noFit: "None." };
    expect(errors(text({ ...ok, label: " " }))).toHaveProperty([
      "text.en.label",
    ]);
    expect(errors(text({ ...ok, header: "a\nb" }))).toHaveProperty([
      "text.en.header",
    ]);
    expect(errors(text({ ...ok, noFit: "x".repeat(201) }))).toHaveProperty([
      "text.en.noFit",
    ]);
    expect(
      errors({ ...custom(), text: { en: ok, "not a locale": ok } }),
    ).toHaveProperty(["text.not a locale"]);
    const many = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [
        `x${String.fromCharCode(97 + (i % 26))}-${i}${i}`,
        ok,
      ]),
    );
    expect(errors({ ...custom(), text: { en: ok, ...many } })).toHaveProperty([
      "text",
    ]);
  });

  it("records a field named like an object property", () => {
    expect(errors(JSON.parse('{"__proto__": 1}'))).toHaveProperty([
      "__proto__",
    ]);
  });

  it.each([
    ["__proto__", JSON.parse('{"__proto__": {}}')],
    ["constructor", { constructor: { name: "x" } }],
    ["toString", { toString: {} }],
    ["link.toString", { link: { ...custom().link, toString: "x" } }],
    [
      "link.__proto__",
      { link: JSON.parse('{"style":"text","icon":"ruler","__proto__":{}}') },
    ],
    ["colors.constructor", { colors: { mode: "theme", constructor: "x" } }],
    [
      "text.en.hasOwnProperty",
      { text: { en: { ...custom().text.en, hasOwnProperty: 1 } } },
    ],
  ])("refuses an inherited name as a field: %s", (path, extra) => {
    expect(errors({ ...custom(), ...extra })).toHaveProperty([path]);
  });
});

describe("fillDefaults", () => {
  it("fills what an older or partial value is missing", () => {
    expect(fillDefaults(undefined, "en")).toEqual(defaultSettings("en"));
    expect(fillDefaults({ v: 1, link: { style: "button" } }, "en")).toEqual({
      ...defaultSettings("en"),
      link: { style: "button", icon: "ruler" },
    });
  });

  it("reads a damaged field as its default and keeps the rest", () => {
    const stored = {
      ...custom(),
      popup: { ...custom().popup, style: "modal", gone: true },
      colors: { mode: "custom", text: "red" },
      css: "</style>",
      text: {
        en: { label: "Fit guide", header: "x\ny", noFit: "No match." },
        fr: { label: "Guide" }, // incomplete: dropped, the guide falls back to en
        es: custom().text.fr,
      },
    };
    const read = fillDefaults(stored, "en");
    expect(read.popup).toEqual({ ...custom().popup, style: "center" });
    expect(read.colors).toEqual({ mode: "theme" });
    expect(read.css).toBe("");
    expect(read.text).toEqual({
      en: { label: "Fit guide", header: "Size guide", noFit: "No match." },
      es: custom().text.fr,
    });
    expect(() => validateSettings(read, "en")).not.toThrow();
  });

  it("keeps at most 50 languages, so what it reads can be saved", () => {
    const ok = custom().text.fr;
    const text = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`fr-x${i}${i}`, ok]),
    );
    const read = fillDefaults({ ...custom(), text: { en: ok, ...text } }, "en");
    expect(Object.keys(read.text)).toHaveLength(50);
    expect(read.text.en).toEqual(ok);
    expect(() => validateSettings(read, "en")).not.toThrow();
  });

  it("gives a new primary locale default words", () => {
    expect(fillDefaults(custom(), "de").text.de).toEqual(
      defaultSettings("de").text.de,
    );
  });
});
