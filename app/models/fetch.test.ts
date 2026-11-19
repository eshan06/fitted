import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  FetchError,
  isPublicAddress,
  publicLookup,
  safeFetch,
} from "./fetch.server";

// Names resolve only to the answers a test sets, and never on the network.
type Answer = { address: string; family: number };
const dns = vi.hoisted(() => new Map<string, Answer[]>());
vi.mock("node:dns", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns")>();
  const lookup = (
    host: string,
    _options: unknown,
    cb: (err: Error | null, addresses?: Answer[]) => void,
  ) =>
    process.nextTick(() => {
      const answer = dns.get(host);
      if (answer) cb(null, answer);
      else
        cb(
          Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" }),
        );
    });
  return { ...real, default: { ...real, lookup }, lookup };
});

// A local server stands in for the hosts below: requests to them are sent to
// it instead of the address their name resolves to, through Node's real HTTP,
// streaming and abort handling. Every other host takes the real path, through
// publicLookup.
const LOCAL = ["shop.test", "www.shop.test", "other.test"];
const pages = new Map<
  string,
  (req: IncomingMessage, res: ServerResponse) => void
>();
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const page = pages.get(`${req.headers.host}${req.url}`);
    if (page) page(req, res);
    else res.writeHead(404).end("missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
afterEach(() => {
  pages.clear();
  dns.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Hop = { url: string; options: http.RequestOptions; answered?: true };
function serveLocally() {
  const hops: Hop[] = [];
  const realHttp = http.request;
  const realHttps = https.request;
  const route =
    (real: typeof http.request) =>
    (
      url: URL,
      options: http.RequestOptions,
      cb: (res: IncomingMessage) => void,
    ) => {
      const hop: Hop = { url: url.href, options };
      hops.push(hop);
      if (!LOCAL.includes(url.hostname)) return real(url, options, cb);
      return realHttp(
        {
          ...options,
          lookup: undefined,
          host: "127.0.0.1",
          port,
          path: url.pathname + url.search,
          headers: { ...options.headers, host: url.host },
        },
        (res) => {
          hop.answered = true;
          cb(res);
        },
      );
    };
  vi.spyOn(http, "request").mockImplementation(
    route(realHttp) as typeof http.request,
  );
  vi.spyOn(https, "request").mockImplementation(
    route(realHttps as typeof http.request) as typeof https.request,
  );
  return hops;
}

const send =
  (body: string | Buffer, headers: Record<string, string> = {}, status = 200) =>
  (_req: IncomingMessage, res: ServerResponse) =>
    res.writeHead(status, headers).end(body);
const redirect = (location: string, status = 302) =>
  send("", { location }, status);
const reason = (p: Promise<unknown>) =>
  p.then(
    () => "no error",
    (err) => (err instanceof FetchError ? err.reason : `other: ${err}`),
  );

describe("isPublicAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "100.100.100.200", // Alibaba metadata, inside carrier-grade NAT
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254", // AWS, GCP and Azure metadata
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.170",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:8.8.8.8", // IPv4-mapped
    "::ffff:127.0.0.1",
    "64:ff9b::808:808", // NAT64
    "64:ff9b:1::1",
    "100::1", // discard
    "fc00::1", // unique-local
    "fd00:ec2::254", // AWS metadata over IPv6
    "fe80::1", // link-local
    "fe80::1%eth0",
    "ff02::1", // multicast
    "2001::1", // Teredo
    "2001:2::1", // benchmarking
    "2001:db8::1", // documentation
    "2002:c000:204::1", // 6to4
    "3fff::1", // documentation
    "localhost",
    "not an address",
    "",
  ])("refuses %s", (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "23.227.38.65", // Shopify's storefronts
    "100.63.255.255", // just below carrier-grade NAT
    "100.128.0.1", // just above it
    "172.15.255.255", // just below 172.16.0.0/12
    "172.32.0.1", // just above it
    "223.255.255.255", // just below multicast
    "2001:4860:4860::8888",
    "2606:4700::6810:84e5",
    "2a00:1450:4001::1",
  ])("allows %s", (ip) => expect(isPublicAddress(ip)).toBe(true));
});

describe("publicLookup", () => {
  const run = (host: string, all: boolean) =>
    new Promise<{ err: unknown; address: unknown; family: unknown }>(
      (resolve) =>
        publicLookup(host, { all }, (err, address, family) =>
          resolve({ err, address, family }),
        ),
    );

  it("answers in the shape the socket asked for", async () => {
    const answer = [
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ];
    dns.set("public.test", answer);
    expect(await run("public.test", true)).toEqual({
      err: null,
      address: answer,
      family: undefined,
    });
    expect(await run("public.test", false)).toEqual({
      err: null,
      address: "8.8.8.8",
      family: 4,
    });
  });

  it("refuses a name when any of its addresses isn't public", async () => {
    dns.set("mixed.test", [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    const { err } = await run("mixed.test", true);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).reason).toBe("blocked");
  });

  it("passes DNS failures through", async () => {
    const { err } = await run("nowhere.test", false);
    expect(err).toMatchObject({ code: "ENOTFOUND" });
  });
});

describe("safeFetch refuses before sending anything", () => {
  it.each([
    "not a link",
    "ftp://shop.test/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://shop.test:8080/",
    "https://shop.test:22/",
    "http://user:secret@shop.test/",
    "http://127.0.0.1/",
    "http://2130706433/", // 127.0.0.1 written as a number
    "http://0x7f.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00:ec2::254]/",
  ])("%s", async (link) => {
    const hops = serveLocally();
    expect(await reason(safeFetch(link))).toBe("blocked");
    expect(hops).toEqual([]);
  });

  it("a host outside allowHosts", async () => {
    const hops = serveLocally();
    const fetching = safeFetch("https://other.test/", {
      allowHosts: ["shop.test"],
    });
    expect(await reason(fetching)).toBe("blocked");
    expect(hops).toEqual([]);
  });
});

describe("safeFetch checks the address it dials", () => {
  it.each<[string, Answer[]]>([
    ["a private address", [{ address: "10.0.0.5", family: 4 }]],
    ["cloud metadata", [{ address: "169.254.169.254", family: 4 }]],
    ["IPv6 loopback", [{ address: "::1", family: 6 }]],
    [
      "a private address among public ones",
      [
        { address: "8.8.8.8", family: 4 },
        { address: "192.168.1.1", family: 4 },
      ],
    ],
  ])("refuses a name that resolves to %s", async (_, answer) => {
    dns.set("rebind.test", answer);
    expect(await reason(safeFetch("http://rebind.test/"))).toBe("blocked");
  });

  it("checks again on every redirect, so DNS rebinding can't slip past", async () => {
    const hops = serveLocally();
    dns.set("rebind.test", [{ address: "10.0.0.7", family: 4 }]);
    pages.set("shop.test/a", redirect("http://rebind.test/admin"));
    expect(await reason(safeFetch("http://shop.test/a"))).toBe("blocked");
    expect(hops.map((h) => h.url)).toEqual([
      "http://shop.test/a",
      "http://rebind.test/admin",
    ]);
  });

  it("dials every hop on a fresh socket through publicLookup", async () => {
    const hops = serveLocally();
    pages.set("shop.test/a", redirect("/b", 301));
    pages.set("shop.test/b", send("ok"));
    await safeFetch("https://shop.test/a");
    expect(hops).toHaveLength(2);
    for (const hop of hops)
      expect(hop.options).toMatchObject({ agent: false, lookup: publicLookup });
  });
});

describe("safeFetch follows redirects", () => {
  it("within allowHosts, returning the final URL", async () => {
    serveLocally();
    pages.set("shop.test/products/a", redirect("https://www.shop.test/a"));
    pages.set("www.shop.test/a", redirect("/a?x=1", 307));
    pages.set("www.shop.test/a?x=1", send("<p>ok</p>"));
    const page = await safeFetch("https://shop.test/products/a", {
      allowHosts: ["Shop.test", "www.shop.test"],
    });
    expect(page).toEqual({
      url: "https://www.shop.test/a?x=1",
      status: 200,
      body: Buffer.from("<p>ok</p>"),
    });
  });

  it("never off allowHosts", async () => {
    const hops = serveLocally();
    pages.set("shop.test/a", redirect("https://other.test/"));
    const fetching = safeFetch("https://shop.test/a", {
      allowHosts: ["shop.test"],
    });
    expect(await reason(fetching)).toBe("blocked");
    expect(hops).toHaveLength(1);
  });

  it.each([
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://shop.test:8080/",
    "ftp://shop.test/",
    "file:///etc/passwd",
    "http://user:secret@shop.test/",
  ])("never to %s", async (location) => {
    const hops = serveLocally();
    pages.set("shop.test/a", redirect(location));
    expect(await reason(safeFetch("https://shop.test/a"))).toBe("blocked");
    expect(hops).toHaveLength(1);
  });

  it("at most 5 times", async () => {
    serveLocally();
    for (let i = 0; i < 6; i++)
      pages.set(`shop.test/${i}`, redirect(`/${i + 1}`));
    pages.set("shop.test/6", send("end"));
    expect((await safeFetch("http://shop.test/1")).body.toString()).toBe("end");
    expect(await reason(safeFetch("http://shop.test/0"))).toBe("blocked");
  });
});

describe("safeFetch reads the body", () => {
  const FIVE_MB = 5 * 1024 * 1024;

  it("decompresses gzip and brotli", async () => {
    serveLocally();
    const html = "<h1>Size chart</h1>".repeat(100);
    pages.set(
      "shop.test/gz",
      send(gzipSync(html), { "content-encoding": "gzip" }),
    );
    pages.set(
      "shop.test/br",
      send(brotliCompressSync(html), { "content-encoding": "br" }),
    );
    expect((await safeFetch("http://shop.test/gz")).body.toString()).toBe(html);
    expect((await safeFetch("http://shop.test/br")).body.toString()).toBe(html);
  });

  it("allows 5 MB and refuses a byte more, counted after decompression", async () => {
    serveLocally();
    pages.set("shop.test/5mb", send(Buffer.alloc(FIVE_MB)));
    pages.set(
      "shop.test/bomb",
      send(gzipSync(Buffer.alloc(FIVE_MB + 1)), { "content-encoding": "gzip" }),
    );
    expect((await safeFetch("http://shop.test/5mb")).body).toHaveLength(
      FIVE_MB,
    );
    expect(await reason(safeFetch("http://shop.test/bomb"))).toBe("too_large");
  });

  it("passes other statuses back for the caller to judge", async () => {
    serveLocally();
    pages.set("shop.test/gone", send("gone", {}, 404));
    pages.set("shop.test/odd", send("", {}, 302));
    expect(await safeFetch("http://shop.test/gone")).toMatchObject({
      status: 404,
    });
    expect(await safeFetch("http://shop.test/odd")).toMatchObject({
      status: 302,
    });
  });

  it("fails on an encoding it didn't ask for, or a body cut short", async () => {
    serveLocally();
    pages.set("shop.test/zstd", send("x", { "content-encoding": "zstd" }));
    pages.set("shop.test/cut", (_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("only ten b");
      setImmediate(() => res.destroy());
    });
    expect(await reason(safeFetch("http://shop.test/zstd"))).toBe("failed");
    expect(await reason(safeFetch("http://shop.test/cut"))).toBe("failed");
  });

  it.each([
    ["an answer", false],
    ["the rest of the body", true],
  ])("gives up after 10 seconds waiting for %s", async (_, sentHeaders) => {
    const handler = (_req: IncomingMessage, res: ServerResponse) => {
      if (!sentHeaders) return; // never answers
      res.writeHead(200);
      res.write("the start");
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hops = serveLocally();
    let reached = false;
    pages.set("shop.test/slow", (req, res) => {
      handler(req, res);
      reached = true;
    });
    let settled = false;
    const fetching = reason(safeFetch("http://shop.test/slow")).finally(
      () => (settled = true),
    );
    // Real I/O: wait until the server has the request and, when it sent
    // headers, until they arrived.
    while (!reached || (sentHeaders && !hops[0]?.answered))
      await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(9_999);
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await fetching).toBe("timeout");
  });
});
