import { describe, expect, it } from "vitest";
import { videoSite } from "./video";

describe("videoSite", () => {
  it.each([
    ["https://www.youtube.com/watch?v=abc", "YouTube"],
    ["https://m.youtube.com/watch?v=abc", "YouTube"],
    ["https://youtu.be/abc", "YouTube"],
    ["https://vimeo.com/1", "Vimeo"],
    ["https://player.vimeo.com/video/1", "Vimeo"],
  ])("names %s as %s", (link, site) => expect(videoSite(link)).toBe(site));

  it.each([
    "http://www.youtube.com/watch?v=abc",
    "https://youtube.com.evil.example/x",
    "https://www.tiktok.com/@a/video/1",
    "javascript:alert(1)",
    "youtube.com/watch?v=abc",
    "https://youtu.be/abc\0",
    "",
    5,
  ])("refuses %j", (link) => expect(videoSite(link)).toBeUndefined());
});
