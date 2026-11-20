// The How to measure image a chart can hold: a PNG or JPG (ARCHITECTURE §5),
// checked by name and by the bytes each kind starts with, in the editor and
// again by the route's action. The metaobject field also takes GIF and WebP,
// so this check is the one that holds it to PNG or JPG.
export const IMAGE_MAX = 20 * 1024 * 1024; // Shopify Files' own cap for images
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG = [0xff, 0xd8, 0xff];
const IMAGES: Record<string, [string, number[]]> = {
  png: ["image/png", PNG],
  jpg: ["image/jpeg", JPG],
  jpeg: ["image/jpeg", JPG],
};
/** The image's MIME type, or undefined when its name or first bytes aren't a PNG's or JPG's. */
export function imageType(name: string, head: Uint8Array) {
  const ext = name.split(".").pop()!.toLowerCase();
  if (!Object.hasOwn(IMAGES, ext)) return undefined;
  const [mime, magic] = IMAGES[ext];
  return magic.every((b, i) => head[i] === b) ? mime : undefined;
}
