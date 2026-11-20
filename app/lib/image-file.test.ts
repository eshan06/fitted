import { describe, expect, it } from "vitest";
import { imageType } from "./image-file";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bytes = (b: number[]) => new Uint8Array(b);

describe("imageType", () => {
  it("names a PNG or JPG by its name and first bytes, whatever the case", () => {
    expect(imageType("TOPS.PNG", bytes(PNG))).toBe("image/png");
    expect(imageType("tops.Jpeg", bytes([0xff, 0xd8, 0xff]))).toBe(
      "image/jpeg",
    );
  });

  it("refuses a name without a PNG or JPG ending, or bytes too short", () => {
    expect(imageType("tops", bytes(PNG))).toBeUndefined();
    expect(imageType("tops.png", bytes(PNG.slice(0, 4)))).toBeUndefined();
    expect(imageType("tops.jpg", bytes([]))).toBeUndefined();
  });
});
