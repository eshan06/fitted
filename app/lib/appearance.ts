// The Appearance values that reach CSS on the storefront (ARCHITECTURE §7):
// checked when they're saved (app/models/settings.server.ts) and again by the
// size guide that applies them (§9), so the two can't drift.

export const COLOR = /^#[0-9a-f]{6}$/i;
// A file in Shopify Files, safe inside CSS url("…") and an attribute.
const FILE = String.raw`https://cdn\.shopify\.com/[^\s"'()\\<]+`;
export const FONT_URL = new RegExp(`^${FILE}$`);
const FILE_URL = new RegExp(String.raw`url\(\s*(["']?)${FILE}\1\s*\)`, "gi");

// What the settings screens say for each problem; the storefront needs none.
export const CSS_WORDS = {
  type: "Must be text",
  size: "Keep custom CSS under 10 KB",
  lt: `Custom CSS can't contain "<"`,
  slash: `Custom CSS can't contain "\\". Type the character itself instead.`,
  import: "Custom CSS can't use @import",
  load: "Custom CSS can load files only through url() with a Shopify Files address (https://cdn.shopify.com/…)",
};

/**
 * What's wrong with custom CSS, or undefined. It lands in a <style> on every
 * product page, so it can't close that element ("<") and loads nothing but
 * Shopify Files. With no "\" in it, no escape can hide an @import or url( from
 * these checks.
 */
export function cssProblem(v: unknown): keyof typeof CSS_WORDS | undefined {
  if (typeof v !== "string") return "type";
  if (new TextEncoder().encode(v).length > 10 * 1024) return "size";
  if (v.includes("<")) return "lt";
  if (v.includes("\\")) return "slash";
  if (/@import/i.test(v)) return "import";
  // image-set(), image(), src() and filter() can load from a quoted URL with no url(.
  if (/url\(|image-set\(|image\(|src\(|filter\(/i.test(v.replace(FILE_URL, "")))
    return "load";
}

// The font files the popup can use, checked by name and by the bytes each
// kind starts with, in the browser and again on the server (#130).
export const FONT_MAX = 2 * 1024 * 1024;
export const FONT_WORDS = {
  type: "Use a WOFF2, WOFF, TTF or OTF file.",
  size: "Use a font file up to 2 MB, like a WOFF2.",
};
const SFNT = String.fromCharCode(0, 1, 0, 0);
const FONTS: Record<string, string[]> = {
  woff2: ["font/woff2", "wOF2"],
  woff: ["font/woff", "wOFF"],
  ttf: ["font/ttf", SFNT, "true"],
  otf: ["font/otf", "OTTO", SFNT],
};
/** The font's MIME type, or undefined when its name or first bytes aren't a font's. */
export function fontType(name: string, head: Uint8Array) {
  const ext = name.split(".").pop()!.toLowerCase();
  const [mime, ...heads] = Object.hasOwn(FONTS, ext) ? FONTS[ext] : [];
  return heads.includes(String.fromCharCode(...head.slice(0, 4)))
    ? mime
    : undefined;
}
/** A file's size as the screen says it: "48 KB", "6.4 MB" (rounded up). */
export const fileSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${Math.ceil(bytes / 104857.6) / 10} MB`;
