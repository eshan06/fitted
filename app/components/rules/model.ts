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
const EXAMPLE: Record<string, string> = {
  tag: "a tag, like women-top",
  type: "a product type, like Shirts",
  vendor: "a vendor, like North Linen",
  metafield: "a value to compare",
};
const NOUN: Record<string, string> = {
  tag: "tag",
  type: "product type",
  vendor: "vendor",
  metafield: "value",
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

/** Charts left with nothing to match aren't ranked, so they drop out on save. */
export function toSave(rules: Rules): Rules {
  const order = rules.order.filter((id) => rules.charts[id]?.match.length);
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
          errs[`${p}.value`] = `Enter ${EXAMPLE[c.field]}.`;
        else if ("value" in c && c.value.length > 255)
          errs[`${p}.value`] =
            `This is ${c.value.length} characters; the most is 255. Put one ${NOUN[c.field]} in each condition.`;
        if ("ids" in c && !c.ids.length)
          errs[`${p}.ids`] = "Pick at least one.";
      });
  return errs;
}

const AT: Record<string, string> = {
  key: "key",
  op: "op",
  value: "value",
  ids: "value",
};
/** The element a field error marks. */
export const elementId = (path: string) => {
  const [, id, list, i, part = ""] = path.split(".");
  const at = AT[part];
  return `r${id?.split("/").pop()}-${list}-${i}-${at ?? "field"}`;
};
