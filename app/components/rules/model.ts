// The Rules board's draft (ARCHITECTURE §6): the screen edits a Rules
// document and checks it the way the canvas words it, keyed like the
// server's fieldErrors. The server validates again on save.
import type { Condition, FieldErrors, Rules } from "../../models/rules.server";

export type Field = Condition["field"];
export type ChartInfo = { id: string; name: string };
// In the order the field picker lists them.
export const LABELS: Record<Field, string> = {
  collection: "Collection",
  tag: "Tag",
  type: "Product type",
  vendor: "Vendor",
  metafield: "Metafield",
  product: "Specific products",
  all: "Everything else",
};
// What each text field holds, and an example.
const NOUN: Record<string, [string, string]> = {
  tag: ["tag", ", like women-top"],
  type: ["product type", ", like Shirts"],
  vendor: ["vendor", ", like North Linen"],
  metafield: ["value", " to compare"],
};
export const FIELDS = Object.keys(LABELS) as Field[];
export const opsFor = (f: Field): string[] =>
  f === "all"
    ? []
    : f === "product" || f === "collection"
      ? ["is", "is_not"]
      : ["is", "is_not", "contains"];

/** A condition of `field`, keeping the old one's comparison when it fits. */
export function blank(field: Field, old?: Condition): Condition {
  const was = old && "op" in old ? old.op : "is";
  const op = opsFor(field).includes(was) ? was : "is";
  if (field === "all") return { field };
  if (field === "product" || field === "collection")
    return { field, op: op as "is", ids: [] };
  if (field === "metafield")
    return { field, key: "", op: op as "is", value: "" };
  return { field, op: op as "is", value: "" };
}

// rules.server.ts's MAX_CHARTS; a test keeps them equal.
export const MAX_CHARTS = 200;

/** The rules for charts that still exist: a deleted chart's never match (§6). */
export const forCharts = (rules: Rules, ids: Set<string>): Rules => ({
  ...rules,
  order: rules.order.filter((id) => ids.has(id)),
});

/** Charts left with no conditions aren't ranked, so they drop out on save. */
export function toSave(rules: Rules): Rules {
  const order = rules.order.filter(
    (id) => rules.charts[id]?.match.length || rules.charts[id]?.exclude.length,
  );
  return {
    v: 1,
    order,
    charts: Object.fromEntries(order.map((id) => [id, rules.charts[id]])),
  };
}

const KEY = /^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,64}$/;
/** The screen's own checks, keyed like the server's fieldErrors. */
export function check(rules: Rules): FieldErrors {
  const errs: FieldErrors = {};
  for (const id of rules.order)
    for (const list of ["match", "exclude"] as const)
      rules.charts[id][list].forEach((c, i) => {
        const p = `charts.${id}.${list}.${i}`;
        if ("key" in c) {
          if (/^app--/i.test(c.key))
            errs[`${p}.key`] =
              "App metafields (starting app--) can't be used in rules. Pick one of your store's own, like custom.fit.";
          else if (!KEY.test(c.key))
            errs[`${p}.key`] = "Use namespace.key, like custom.fit.";
        }
        if ("value" in c && !c.value.trim())
          errs[`${p}.value`] = `Enter a ${NOUN[c.field].join("")}.`;
        else if ("value" in c && c.value.length > 255)
          errs[`${p}.value`] =
            `This is ${c.value.length} characters; the most is 255. Put one ${NOUN[c.field][0]} in each condition.`;
        if ("ids" in c && !c.ids.length)
          errs[`${p}.ids`] = "Pick at least one.";
      });
  return errs;
}

/** The element a field error marks: the picker's button stands for its ids. */
export const elementId = (path: string) => {
  const [, id, list, i, part = ""] = path.split(".");
  const at = part === "ids" ? "value" : part || "field";
  return `r${id?.split("/").pop()}-${list}-${i}-${at}`;
};

// Free's fields (§8); the rest need Standard.
export const PAID: Field[] = ["tag", "type", "vendor", "metafield"];
export const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

// What's wrong with a condition, in the banners' short words, from the
// screen's checks or the server's.
function short(message: string, part: string, c: unknown) {
  const value = (c as { value?: unknown }).value;
  if (/^(App metafields|Rules can't use an app)/.test(message))
    return "belongs to an app, so rules can't use it";
  if (part === "key") return "isn't a metafield key";
  if (part === "value")
    return typeof value === "string" && value.length > 255
      ? "is longer than 255 characters"
      : "has no value";
  if (part === "ids") return "has nothing picked";
  return null;
}
// The condition a field error's path names, in a document that may be damaged.
export const at = (rules: unknown, path: string) => {
  const [top, id, list, i] = path.split(".");
  const c =
    top === "charts" &&
    (rules as Rules | null)?.charts?.[id]?.[list as "match"]?.[+i];
  return c && typeof c === "object" ? (c as Condition) : undefined;
};

/** Each field error as the Fix banner lists it, linked by `path` when it marks a condition; another chart's names it. */
export function problems(
  rules: Rules,
  errors: FieldErrors,
  charts: ChartInfo[],
  current: string,
): { path?: string; where: string; text: string }[] {
  return Object.entries(errors).map(([path, message]) => {
    const [, id, list, , part = ""] = path.split(".");
    const c = at(rules, path);
    if (!c) return { where: "", text: message };
    const s = short(message, part, c);
    const chart =
      id === current ? "" : `${charts.find((ch) => ch.id === id)?.name}: `;
    return {
      path,
      where: `${chart}${list === "exclude" ? "Never show it on: " : ""}${LABELS[c.field]}`,
      text: s ? ` ${s}` : `: ${message}`,
    };
  });
}

/** Saved rules' problems, worded from the stored document (§6). */
export function storedProblems(
  errors: FieldErrors,
  value: unknown,
  charts: ChartInfo[],
): string[] {
  return Object.entries(errors).map(([path, message]) => {
    const [top, id, , , part = ""] = path.split(".");
    const chart = charts.find((ch) => ch.id === id)?.name;
    if (top !== "charts" || !chart) return message;
    const c = at(value, path);
    const s = c ? short(message, part, c) : null;
    const key = c && "key" in c && typeof c.key === "string" && c.key;
    if (key && s === "isn't a metafield key") return `${chart}: ${key} ${s}`;
    if (c && s && Object.hasOwn(LABELS, c.field))
      return `${chart}: a ${lower(LABELS[c.field])} condition ${s}`;
    return `${chart}: ${lower(message)}`;
  });
}

// The job's plain reason (§13), as the applying banner words it.
const REASON: Record<string, string> = {
  "Shopify request failed": "Shopify stopped responding",
  "Something went wrong": "Fitted stopped before it finished",
  "The job stopped before it finished": "Fitted stopped before it finished",
};
export const reason = (error: string | null) =>
  !error
    ? "Shopify stopped responding"
    : (REASON[error] ?? (error.startsWith("Shopify") ? error : lower(error)));
