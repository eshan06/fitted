// The font files the popup can use, checked by name and by the bytes each
// kind starts with (ARCHITECTURE §7, #130). Apart from appearance.ts, which
// the size guide bundles: shoppers never need these.
export const FONT_MAX = 2 * 1024 * 1024;
export const FONT_WORDS = {
  type: "Use a WOFF2, WOFF, TTF or OTF file.",
  size: "Use a font file up to 2 MB, like a WOFF2.",
  failed: "Shopify didn't answer, so the popup still uses your theme's font.",
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
