import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

// Shoppers' size guide events (ARCHITECTURE §12). The guide posts to
// /apps/fitted/events on the store, and Shopify signs the request on to here.
// The shop comes only from that signed query. Nothing about the shopper is
// kept: logged_in_customer_id and the user agent are never read, and the IP
// only counts requests, in memory. The storefront never retries an event or
// shows its failure, so a failed write is logged.
const ROUTE = "proxy/events";
const MAX_BYTES = 1024;
const MINUTE = 60_000;
const DAY = 86_400_000;
const PER_MINUTE = 30; // per IP and shop
// Per shop and UTC day. Only stored events count, so a day with this many
// rows is a day that hit the cap.
const PER_DAY = 20_000;
const MAX_KEYS = 10_000;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHART = /^gid:\/\/shopify\/Metaobject\/[1-9][0-9]{0,19}$/;
const PRODUCT = /^gid:\/\/shopify\/Product\/[1-9][0-9]{0,19}$/;
const SIZE = /^[a-z0-9]{1,8}$/; // §5's id rule
// Whether each type carries a size row id: never an open, a fit result when
// something fit, an add to cart always.
const SIZED = new Map([
  ["open", "never"],
  ["fit_result", "maybe"],
  ["add_to_cart", "always"],
]);
const is = (v: unknown, re: RegExp): v is string =>
  typeof v === "string" && re.test(v);

/** The event a body holds, or null for anything else, unknown keys included. */
function parse(text: string) {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof d !== "object" || d === null || Array.isArray(d)) return null;
  const { id, type, chart, product, size, ...rest } = d as Record<
    string,
    unknown
  >;
  const sized = SIZED.get(type as string);
  const sizeOk =
    size === undefined
      ? sized !== "always"
      : sized !== "never" && is(size, SIZE);
  if (Object.keys(rest).length || !sized || !sizeOk) return null;
  if (!is(id, UUID) || !is(chart, CHART) || !is(product, PRODUCT)) return null;
  return {
    id,
    type: type as string,
    chartId: chart,
    productId: product,
    size: (size as string | undefined) ?? null,
  };
}

/** The body as text, or null once it passes MAX_BYTES, read no further. */
async function read(request: Request) {
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

// Requests counted per key until a time. A map at MAX_KEYS drops the key whose
// count started first, so the maps stay bounded.
// ponytail: counts live in this one instance's memory (§17); a shared store if
// Railway ever runs two.
type Count = { n: number; until: number };
const perIp = new Map<string, Count>();
const perShop = new Map<string, Count>();
function tally(map: Map<string, Count>, key: string, until: number) {
  let c = map.get(key);
  if (!c || c.until <= Date.now()) {
    map.delete(key);
    if (map.size >= MAX_KEYS) map.delete(map.keys().next().value as string);
    map.set(key, (c = { n: 0, until }));
  }
  return c;
}

// The shopper's IP: Shopify adds it to X-Forwarded-For as it signs the request
// on, and the host in front of this app adds Shopify's after it. Entries
// before it are whatever the browser sent. Without it, only the day's cap
// applies, so no shopper's event is refused for another's.
const shopperIp = (request: Request) =>
  request.headers.get("x-forwarded-for")?.split(",").at(-2)?.trim();

const answer = (status: number) => new Response(null, { status });

export const action = async ({ request }: ActionFunctionArgs) => {
  // A bad signature, or a timestamp over 90 seconds off, throws 400.
  await authenticate.public.appProxy(request);
  const shop = new URL(request.url).searchParams.get("shop") ?? "";
  const now = Date.now();
  const ip = shopperIp(request);
  if (ip && ++tally(perIp, `${shop} ${ip}`, now + MINUTE).n > PER_MINUTE)
    return answer(429);
  const text = await read(request);
  const event = text === null ? null : parse(text);
  if (!event) return answer(400);
  const today = tally(perShop, shop, (Math.floor(now / DAY) + 1) * DAY);
  if (today.n >= PER_DAY) return answer(429);
  try {
    // A replayed id finds its row there and adds none.
    const { count } = await db.event.createMany({
      data: { shop, ...event },
      skipDuplicates: true,
    });
    today.n += count;
  } catch (err) {
    console.log(
      JSON.stringify({
        level: "error",
        msg: "Event not saved",
        shop,
        route: ROUTE,
        error: String(err),
      }),
    );
    return answer(500);
  }
  return answer(204);
};
