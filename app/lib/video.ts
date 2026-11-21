// A chart's fit video link (ARCHITECTURE §5): an https YouTube or Vimeo link,
// checked the same way by the editor and by validateChart.
const HOSTS: [RegExp, string][] = [
  [/^((www\.|m\.)?youtube\.com|youtu\.be)$/, "YouTube"],
  [/^(www\.|player\.)?vimeo\.com$/, "Vimeo"],
];
export const VIDEO_ERROR = "Use an https link from YouTube or Vimeo.";

/** "YouTube" or "Vimeo", or undefined when the link isn't one Fitted takes. */
export function videoSite(link: unknown) {
  if (typeof link !== "string" || link.includes("\0")) return undefined;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  return HOSTS.find(([host]) => host.test(url.hostname))?.[1];
}
