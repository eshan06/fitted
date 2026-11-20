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
  load: "Custom CSS can load files only from Shopify Files (https://cdn.shopify.com/)",
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
  // image-set(), image() and src() load from a quoted URL with no url(.
  if (/url\(|image-set\(|image\(|src\(/i.test(v.replace(FILE_URL, "")))
    return "load";
}
