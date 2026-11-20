// The Appearance values that reach CSS on the storefront (ARCHITECTURE §7):
// checked when they're saved (app/models/settings.server.ts) and again by the
// size guide that applies them (§9), so the two can't drift.

export const COLOR = /^#[0-9a-f]{6}$/i;
// A file in Shopify Files, safe inside CSS url("…") and an attribute.
const FILE = String.raw`https://cdn\.shopify\.com/[^\s"'()\\<]+`;
export const FONT_URL = new RegExp(`^${FILE}$`);
const FILE_URL = new RegExp(String.raw`url\(\s*(["']?)${FILE}\1\s*\)`, "gi");

/**
 * Why custom CSS can't be used, or undefined. It lands in a <style> on every
 * product page, so it can't close that element ("<") and loads nothing but
 * Shopify Files. With no "\" in it, no escape can hide an @import or url( from
 * these checks.
 */
export function cssProblem(v: unknown): string | undefined {
  if (typeof v !== "string") return "Must be text";
  if (new TextEncoder().encode(v).length > 10 * 1024)
    return "Keep custom CSS under 10 KB";
  if (v.includes("<")) return `Custom CSS can't contain "<"`;
  if (v.includes("\\"))
    return `Custom CSS can't contain "\\". Type the character itself instead.`;
  if (/@import/i.test(v)) return "Custom CSS can't use @import";
  // image-set(), image() and src() load from a quoted URL with no url(.
  if (/url\(|image-set\(|image\(|src\(/i.test(v.replace(FILE_URL, "")))
    return "Custom CSS can load files only from Shopify Files (https://cdn.shopify.com/)";
}
