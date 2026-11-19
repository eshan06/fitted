// Settings in the `$app.settings` shop metafield (ARCHITECTURE §7). The
// Appearance and Fit finder screens write it whole, with the digest they
// loaded, so a save over a newer one is refused (§6) instead of dropping it.

// A check returns the problem, or undefined. `T` is the type it accepts, so
// Settings below is derived from the checks and can't drift from them.
type Check<T = unknown> = { (v: unknown): string | undefined; accepts?: T };
const bool: Check<boolean> = (v) =>
  typeof v === "boolean" ? undefined : "Must be true or false";
const oneOf =
  <const T extends readonly unknown[]>(...list: T): Check<T[number]> =>
  (v) =>
    list.includes(v) ? undefined : "Pick one of the options";
const COLOR = /^#[0-9a-f]{6}$/i;
const color: Check<string> = (v) =>
  typeof v === "string" && COLOR.test(v) ? undefined : "Use a #rrggbb color";
// An upload to Shopify Files, safe to print inside CSS url() and an attribute.
const FONT_URL = /^https:\/\/cdn\.shopify\.com\/[^\s"'()\\<]+$/;
const font: Check<"theme" | { fileUrl: string }> = (v) =>
  v === "theme" ||
  (isObj(v) &&
    Object.keys(v).join() === "fileUrl" &&
    typeof v.fileUrl === "string" &&
    v.fileUrl.length <= 1000 &&
    FONT_URL.test(v.fileUrl))
    ? undefined
    : "Upload the font again";
const selector: Check<string> = (v) =>
  typeof v === "string" && v.length <= 200 && !/[\r\n<]/.test(v)
    ? undefined
    : "Use one line of at most 200 characters";
const css: Check<string> = (v) =>
  typeof v !== "string"
    ? "Must be text"
    : Buffer.byteLength(v) > 10 * 1024
      ? "Keep custom CSS under 10 KB"
      : v.includes("<")
        ? `Custom CSS can't contain "<"`
        : undefined;
const line: Check<string> = (v) =>
  typeof v === "string" && v.trim() && v.length <= 200 && !/[\r\n]/.test(v)
    ? undefined
    : "Use one line of at most 200 characters";

// Every object section's fields and their checks.
const SECTIONS = {
  link: {
    style: oneOf("text", "button", "tab"),
    icon: oneOf("ruler", "hanger", "tape", "none"),
  },
  popup: {
    style: oneOf("center", "drawer"),
    sheetOnPhone: bool,
    openFrom: oneOf("bottom", "right", "fade"),
    font,
    logo: bool,
    sticky: bool,
    rtl: bool,
    fitOnly: bool,
  },
  placement: {
    productBlock: bool,
    quickView: bool,
    floatingTab: bool,
    featured: bool,
    selector,
  },
  units: { default: oneOf("country", "in", "cm"), toggle: bool },
  fitFinder: {
    type: oneOf("basic", "advanced", "custom"),
    answers: oneOf("inputs", "sliders"),
    fitBars: bool,
    otherSizes: bool,
    addToCart: bool,
    onButton: bool,
    similar: bool,
    note: bool,
    askAge: bool,
  },
} satisfies Record<string, Record<string, Check>>;

export type Text = { label: string; header: string; noFit: string };
type Shape<C> = { [K in keyof C]: C[K] extends Check<infer T> ? T : never };
export type Settings = { v: 1 } & {
  [K in keyof typeof SECTIONS]: Shape<(typeof SECTIONS)[K]>;
} & {
  colors:
    | { mode: "theme" }
    | { mode: "custom"; text: string; accent: string; background: string };
  css: string; // at most 10 KB, refused if it contains "<"
  text: Record<string, Text>; // by locale; the primary locale is required
};

export const DEFAULT_TEXT: Text = {
  label: "Size guide",
  header: "Size guide",
  noFit: "We couldn't find a good match. Check the size chart or message us.",
};
// The canvas's Appearance and Fit finder boards, as first drawn.
const DEFAULTS: Omit<Settings, "text"> = {
  v: 1,
  link: { style: "text", icon: "ruler" },
  popup: {
    style: "center",
    sheetOnPhone: true,
    openFrom: "bottom",
    font: "theme",
    logo: true,
    sticky: true,
    rtl: false,
    fitOnly: false,
  },
  placement: {
    productBlock: true,
    quickView: false,
    floatingTab: false,
    featured: false,
    selector: "",
  },
  colors: { mode: "theme" },
  units: { default: "country", toggle: true },
  css: "",
  fitFinder: {
    type: "advanced",
    answers: "inputs",
    fitBars: true,
    otherSizes: true,
    addToCart: true,
    onButton: true,
    similar: false,
    note: true,
    askAge: false,
  },
};
export const defaultSettings = (primaryLocale: string): Settings => ({
  ...structuredClone(DEFAULTS),
  text: { [primaryLocale]: { ...DEFAULT_TEXT } },
});

export type FieldErrors = Record<string, string>;
export class SettingsValidationError extends Error {
  constructor(readonly fieldErrors: FieldErrors) {
    super("The settings have invalid fields");
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const MAX_LOCALES = 50;
const TEXT = { label: line, header: line, noFit: line };

// Errors by field path, for one top-level key.
function check(key: string, v: unknown, primaryLocale: string): FieldErrors {
  const errs: FieldErrors = Object.create(null);
  // Own keys only, so names like "constructor" or "__proto__" are unknown fields.
  const fields = Object.hasOwn(SECTIONS, key)
    ? (SECTIONS as Record<string, Record<string, Check>>)[key]
    : undefined;
  const shape = (o: unknown, checks: Record<string, Check>, path: string) => {
    if (!isObj(o)) return void (errs[path] = "Missing settings");
    for (const k of Object.keys(o))
      if (!Object.hasOwn(checks, k)) errs[`${path}.${k}`] = "Unknown field";
    for (const [k, c] of Object.entries(checks)) {
      const problem = c(o[k]);
      if (problem) errs[`${path}.${k}`] = problem;
    }
  };
  if (fields) shape(v, fields, key);
  else if (key === "v") v === 1 || (errs.v = "Must be 1");
  else if (key === "css") {
    const problem = css(v);
    if (problem) errs.css = problem;
  } else if (key === "colors") {
    if (isObj(v) && v.mode === "theme")
      shape(v, { mode: () => undefined }, key);
    else
      shape(
        v,
        {
          mode: oneOf("custom"),
          text: color,
          accent: color,
          background: color,
        },
        key,
      );
  } else if (key === "text") {
    if (!isObj(v)) return { text: "Missing words" };
    const locales = Object.keys(v);
    if (locales.length > MAX_LOCALES) errs.text = "Too many languages";
    if (!locales.includes(primaryLocale))
      errs[`text.${primaryLocale}`] = "Missing words";
    for (const l of locales)
      if (!LOCALE.test(l)) errs[`text.${l}`] = "Unknown language";
      else shape(v[l], TEXT, `text.${l}`);
  } else errs[key] = "Unknown field";
  return errs;
}

/** The whole document for a write. Throws SettingsValidationError. */
export function validateSettings(
  input: unknown,
  primaryLocale: string,
): Settings {
  if (!isObj(input))
    throw new SettingsValidationError({ "": "Must be settings" });
  const keys = new Set([
    ...Object.keys(input),
    ...Object.keys(DEFAULTS),
    "text",
  ]);
  const errs = Object.assign(
    Object.create(null),
    ...[...keys].map((k) => check(k, input[k], primaryLocale)),
  );
  if (Object.keys(errs).length) throw new SettingsValidationError(errs);
  return input as Settings;
}

/**
 * The stored value with defaults filled. A field that's missing or doesn't
 * validate (an older or damaged value) reads as its default, so the screens
 * still open and the next save repairs it. Other languages keep only valid
 * entries; the storefront falls back to the primary locale for the rest.
 */
export function fillDefaults(stored: unknown, primaryLocale: string): Settings {
  const raw = isObj(stored) ? stored : {};
  const out = defaultSettings(primaryLocale);
  const fill = (
    target: object,
    from: unknown,
    checks: Record<string, Check>,
  ) => {
    if (isObj(from))
      for (const [f, c] of Object.entries(checks))
        if (!c(from[f])) (target as Record<string, unknown>)[f] = from[f];
  };
  for (const [k, checks] of Object.entries(SECTIONS))
    fill(out[k as keyof typeof SECTIONS], raw[k], checks);
  for (const k of ["colors", "css"] as const)
    if (!Object.keys(check(k, raw[k], primaryLocale)).length)
      Object.assign(out, { [k]: raw[k] });
  if (isObj(raw.text))
    for (const [l, t] of Object.entries(raw.text))
      if (l === primaryLocale) fill(out.text[l], t, TEXT);
      else if (
        Object.keys(out.text).length < MAX_LOCALES &&
        !Object.keys(
          check(
            "text",
            { [primaryLocale]: DEFAULT_TEXT, [l]: t },
            primaryLocale,
          ),
        ).length
      )
        out.text[l] = t as Text;
  return out;
}

type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown>; signal?: AbortSignal },
  ) => Promise<Response>;
};
/** Shopify didn't answer, or answered with errors. Routes show it as a 502. */
export class SettingsReadWriteError extends Error {}
/** Someone saved since this screen loaded. Routes show it as a 409. */
export class SettingsConflictError extends Error {}

const TIMEOUT_MS = 5_000; // per call, so a loader never hangs on Shopify
// ponytail: inline calls with no retries; move onto #59's admin.server.ts helper when it lands.
async function call(
  admin: Admin,
  query: string,
  variables?: Record<string, unknown>,
) {
  const response = await admin
    .graphql(query, { variables, signal: AbortSignal.timeout(TIMEOUT_MS) })
    .catch((error) => {
      if (error instanceof Response) throw error; // re-auth
      throw new SettingsReadWriteError(`Admin API request failed: ${error}`);
    });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.data || body.errors)
    throw new SettingsReadWriteError(
      `Admin API returned ${response.status}: ${JSON.stringify(body?.errors ?? null)}`,
    );
  return body.data;
}

export type Loaded = {
  settings: Settings;
  digest: string | null; // null: never saved
  shopId: string;
  primaryLocale: string;
};

export async function getSettings(admin: Admin): Promise<Loaded> {
  const data = await call(
    admin,
    `#graphql
    query FittedSettings {
      shop {
        id
        metafield(namespace: "$app", key: "settings") {
          jsonValue
          compareDigest
        }
      }
      shopLocales {
        locale
        primary
      }
    }`,
  );
  const primaryLocale = data.shopLocales?.find(
    (l: { primary?: boolean }) => l?.primary,
  )?.locale;
  if (typeof data.shop?.id !== "string" || typeof primaryLocale !== "string")
    throw new SettingsReadWriteError(
      "Admin API returned no shop or primary locale",
    );
  const metafield = data.shop.metafield;
  return {
    settings: fillDefaults(metafield?.jsonValue, primaryLocale),
    digest: metafield?.compareDigest ?? null,
    shopId: data.shop.id,
    primaryLocale,
  };
}

/**
 * Writes the whole document over the one with `digest`. Returns the new digest.
 * Only `digest` may come from a browser: take `shopId` and `primaryLocale`
 * from getSettings in the same request.
 */
export async function saveSettings(
  admin: Admin,
  { shopId, primaryLocale, digest }: Omit<Loaded, "settings">,
  input: unknown,
): Promise<string> {
  const settings = validateSettings(input, primaryLocale);
  const data = await call(
    admin,
    `#graphql
    mutation SaveFittedSettings($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          compareDigest
        }
        userErrors {
          field
          message
          code
        }
      }
    }`,
    {
      metafields: [
        {
          ownerId: shopId,
          namespace: "$app",
          key: "settings",
          type: "json",
          value: JSON.stringify(settings),
          compareDigest: digest ?? null, // never omitted: an omitted digest skips the check
        },
      ],
    },
  );
  const result = data.metafieldsSet;
  const userErrors = result?.userErrors;
  if (!Array.isArray(userErrors))
    throw new SettingsReadWriteError("metafieldsSet returned no result");
  // A digest that doesn't match, or that a browser garbled, is a stale save.
  const stale = ["STALE_OBJECT", "INVALID_COMPARE_DIGEST"];
  if (userErrors.some((e: { code?: string }) => stale.includes(e?.code ?? "")))
    throw new SettingsConflictError("The settings changed since they loaded");
  const saved = result.metafields?.[0]?.compareDigest;
  if (userErrors.length || typeof saved !== "string")
    throw new SettingsReadWriteError(
      `metafieldsSet failed: ${JSON.stringify(userErrors)}`,
    );
  return saved;
}
