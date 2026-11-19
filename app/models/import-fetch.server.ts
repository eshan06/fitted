// The one way Fitted reads a URL it doesn't own (ARCHITECTURE §13): the Kiwi
// storefront scan (#35), links inside imported content (#37) and pasted links
// (#39). The body that comes back is untrusted bytes.
import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip } from "node:zlib";

const MAX_REDIRECTS = 5;
const MAX_BYTES = 5 * 1024 * 1024; // counted after decompression
const TIMEOUT_MS = 10_000; // for the whole fetch, redirects included
const REDIRECTS = [301, 302, 303, 307, 308];
const HEADERS = {
  "accept-encoding": "gzip, br",
  "user-agent": "Mozilla/5.0 (compatible; Fitted/1.0)",
};

export class FetchError extends Error {
  constructor(
    readonly reason: "blocked" | "timeout" | "too_large" | "failed",
    message: string,
  ) {
    super(message);
  }
}

// Only global unicast addresses pass. IPv6 must sit in 2000::/3, which leaves
// out loopback, IPv4-mapped, NAT64, unique-local, link-local and multicast;
// the lists name the special-purpose ranges that remain.
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const refused = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 3], // multicast, reserved, broadcast
] as const)
  refused.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["2001::", 23], // IETF protocol assignments: Teredo, ORCHID, benchmarking
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["3fff::", 20], // documentation
] as const)
  refused.addSubnet(net, bits, "ipv6");

export function isPublicAddress(ip: string) {
  try {
    const family = isIP(ip);
    if (family === 4) return !refused.check(ip, "ipv4");
    return (
      family === 6 && global6.check(ip, "ipv6") && !refused.check(ip, "ipv6")
    );
  } catch {
    return false; // an address BlockList can't parse, such as one with a zone
  }
}

// Every hop: http or https on ports 80 and 443, no credentials, one of
// allowHosts when given, and an IP literal must be public (Node dials those
// without calling the lookup below).
function check(url: URL, allowHosts?: readonly string[]) {
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["", "80", "443"].includes(url.port) ||
    url.username ||
    url.password ||
    (allowHosts && !allowHosts.some((h) => h.toLowerCase() === host)) ||
    (isIP(host) && !isPublicAddress(host))
  )
    throw new FetchError("blocked", `Refused ${url.protocol}//${url.host}`);
}

// The socket calls this while connecting, on every hop, so the address checked
// is the address dialed: a name that resolves to a private address, even only
// on a later lookup (DNS rebinding), is refused.
export const publicLookup: LookupFunction = (hostname, options, callback) =>
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    if (
      !addresses.length ||
      !addresses.every((a) => isPublicAddress(a.address))
    )
      return callback(new FetchError("blocked", `Refused ${hostname}`), "");
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });

// agent: false gives every hop a fresh socket, so no pooled connection skips
// publicLookup. A request can close with neither a response nor an error (a
// 101 Switching Protocols with no upgrade handler), so close settles it too;
// after a response it changes nothing.
const send = (url: URL, signal: AbortSignal) =>
  new Promise<http.IncomingMessage>((resolve, reject) => {
    (url.protocol === "https:" ? https : http)
      .request(
        url,
        { agent: false, lookup: publicLookup, signal, headers: HEADERS },
        resolve,
      )
      .on("error", reject)
      .on("close", () =>
        reject(new FetchError("failed", "Closed without an answer")),
      )
      .end();
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readBody(res: http.IncomingMessage) {
  const encoding = (res.headers["content-encoding"] || "identity")
    .trim()
    .toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? createGunzip()
      : encoding === "br"
        ? createBrotliDecompress()
        : null;
  if (!decoder && encoding !== "identity") {
    res.destroy();
    throw new FetchError("failed", `Unsupported encoding ${encoding}`);
  }
  // Copied into one buffer that doubles as it fills, so a body trickled a
  // byte per chunk holds at most twice its size, not millions of chunk
  // objects. Leaving the loop early destroys the streams, and the socket with
  // them; a body cut short throws.
  let body = Buffer.alloc(16 * 1024);
  let bytes = 0;
  for await (const chunk of decoder ? pipeline(res, decoder, () => {}) : res) {
    const end = bytes + chunk.length;
    if (end > MAX_BYTES) throw new FetchError("too_large", "Over 5 MB");
    if (end > body.length) {
      const grown = Buffer.alloc(
        Math.min(MAX_BYTES, Math.max(end, body.length * 2)),
      );
      body.copy(grown, 0, 0, bytes);
      body = grown;
    }
    bytes += (chunk as Buffer).copy(body, bytes);
  }
  return body.subarray(0, bytes);
}

// Non-2xx answers come back for the caller to judge; only redirects are
// followed, gapMs apart when a caller paces its requests.
export async function safeFetch(
  link: string,
  {
    allowHosts,
    gapMs = 0,
  }: { allowHosts?: readonly string[]; gapMs?: number } = {},
): Promise<{ url: string; status: number; body: Buffer }> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new FetchError("blocked", "Not a link");
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    for (let redirects = 0; ; redirects++) {
      check(url, allowHosts);
      if (redirects && gapMs) await sleep(gapMs);
      const res = await send(url, abort.signal);
      const status = res.statusCode ?? 0;
      if (REDIRECTS.includes(status) && res.headers.location) {
        res.destroy();
        if (redirects === MAX_REDIRECTS)
          throw new FetchError("blocked", "Too many redirects");
        url = new URL(res.headers.location, url);
        continue;
      }
      return { url: url.href, status, body: await readBody(res) };
    }
  } catch (err) {
    if (abort.signal.aborted)
      throw new FetchError("timeout", "No answer within 10 seconds");
    if (err instanceof FetchError) throw err;
    throw new FetchError("failed", String(err));
  } finally {
    clearTimeout(timer);
  }
}
