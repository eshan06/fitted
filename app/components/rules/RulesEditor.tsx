// The Rules board (Fitted canvas): one chart's conditions, the priority list,
// the save through App Bridge's save bar, then the resolve's progress.
import { useEffect, useState } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import type { Condition, FieldErrors, Rules } from "../../models/rules.server";
import * as model from "./model";
import "./rules.css";

export type Job = { status: string; error: string | null; at: number } | null;
export type Loaded = {
  charts: model.ChartInfo[];
  rules: Rules;
  digest: string | null;
  damaged: FieldErrors | null;
  job: Job;
  products: number | null;
  free: boolean;
  checkFailed: boolean;
  store: string;
};
type Answer = {
  ok?: true;
  at?: number;
  fieldErrors?: FieldErrors;
  error?: { code: string; checkFailed?: boolean };
};
type Rule = Rules["charts"][string];
type List = "match" | "exclude";

// The canvas's words: a heading, then its lines; "**" marks the bold one.
export const COPY: Record<string, string[]> = {
  conflict: [
    "Display rules changed since you opened them",
    "Another tab, staff member or import changed them, so your edits weren't saved.",
    "**Reload latest shows the newest rules and discards your edits.",
  ],
  product_access: [
    "You need Products access to save rules",
    "Nothing was saved, since saving rules also updates your products.",
    "**Ask the store owner to add Products access to your account in Settings › Users.",
  ],
  shopify: [
    "Your rule changes weren't saved",
    "Shopify didn't respond in time, so products still show the charts they did before. Your edits are still here.",
  ],
  damaged: [
    "Your saved display rules couldn't be read",
    "They were changed outside Fitted, so products keep their current charts until you fix them.",
  ],
  load: [
    "Your display rules didn't load",
    "Fitted couldn't reach your store just now. Your charts still show on the same products as before.",
  ],
};
export function Banner(props: {
  copy: string[];
  tone?: "critical" | "info";
  children?: React.ReactNode;
}) {
  const [heading, ...lines] = props.copy;
  return (
    <s-banner tone={props.tone ?? "critical"} heading={heading}>
      {lines.map((l) => (
        <s-paragraph key={l}>
          {l.startsWith("**") ? <strong>{l.slice(2)}</strong> : l}
        </s-paragraph>
      ))}
      {props.children}
    </s-banner>
  );
}

// ponytail: assumes the app's handle is its name; read it from the Partner Dashboard if they differ.
const plans = (store: string) =>
  `https://admin.shopify.com/store/${store}/charges/fitted/pricing_plans`;
const NONE: Rule = { match: [], exclude: [], auto: true };
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
// The job records a plain reason (§13); the banner words it.
const reason = (error: string | null) =>
  error?.startsWith("Shopify refused")
    ? error
    : error && error !== "Shopify request failed"
      ? "Fitted stopped before it finished"
      : "Shopify stopped responding";
const post = (f: { submit: (b: never, o: object) => unknown }, body: object) =>
  f.submit(body as never, { method: "post", encType: "application/json" });

export function RulesEditor(props: {
  loaded: Loaded;
  heading: React.ReactNode;
}) {
  const { loaded } = props;
  const shopify = useAppBridge();
  const fetcher = useFetcher<Answer>();
  const apply = useFetcher<Answer>();
  const poll = useFetcher<{ job: Job }>();
  const revalidator = useRevalidator();
  const ids = new Set(loaded.charts.map((c) => c.id));
  const [base, setBase] = useState({
    digest: loaded.digest,
    initial: model.forCharts(loaded.rules, ids),
  });
  const [draft, setDraft] = useState(base.initial);
  const [local, setLocal] = useState<Answer | null>(null);
  const [dismissed, setDismissed] = useState<Answer>();
  const [retried, setRetried] = useState(false); // the newest answer is Try again's
  const [redo, setRedo] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [dragging, setDragging] = useState(-1);
  // Newer rules loaded (a save, Reload latest): they replace the edits.
  if (loaded.digest !== base.digest) {
    const initial = model.forCharts(loaded.rules, ids);
    setBase({ digest: loaded.digest, initial });
    setDraft(initial);
    setDismissed(fetcher.data);
  }
  const { initial } = base;

  const saving = fetcher.state !== "idle";
  const answer = saving ? undefined : retried ? apply.data : fetcher.data;
  const notice = local ?? (answer === dismissed ? undefined : answer);
  const errors = notice?.fieldErrors ?? {};
  const err = notice?.error;
  const name = (id: string) =>
    loaded.charts.find((c) => c.id === id)?.name ?? "";
  const current =
    selected && ids.has(selected)
      ? selected
      : (draft.order[0] ?? loaded.charts[0].id);
  const rule = draft.charts[current] ?? NONE;

  // The resolve a save or Try again started, until a job newer than it ends (§13).
  const polled = poll.data?.job;
  const job =
    polled && polled.at >= (loaded.job?.at ?? 0) ? polled : loaded.job;
  const startedAt = Math.max(fetcher.data?.at ?? 0, apply.data?.at ?? 0);
  // ponytail: a resolve that never records a job polls until the page closes.
  const applying =
    job?.status === "running" || (startedAt > 0 && (job?.at ?? 0) < startedAt);
  const { load } = poll;
  useEffect(() => {
    if (!applying) return;
    const t = setInterval(() => load("/app/rules?job"), 3000);
    return () => clearInterval(t);
  }, [applying, load]);

  const setRule = (id: string, next: Rule) =>
    setDraft((d) => ({
      ...d,
      order: d.order.includes(id) ? d.order : [...d.order, id],
      charts: { ...d.charts, [id]: next },
    }));
  const setList = (list: List, items: Condition[]) =>
    setRule(current, { ...rule, [list]: items });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= draft.order.length || from < 0) return;
    const order = [...draft.order];
    order.splice(to, 0, ...order.splice(from, 1));
    setDraft({ ...draft, order });
  };
  const save = () => {
    const rules = model.toSave(draft);
    const fieldErrors = model.check(rules);
    const bad = Object.keys(fieldErrors).length > 0;
    setLocal(bad ? { fieldErrors } : null);
    setRetried(false);
    if (!bad) post(fetcher, { rules, digest: base.digest });
  };
  const retryApply = () => {
    setLocal(null);
    setRetried(true);
    post(apply, { intent: "apply" });
  };
  const dismiss = () => {
    setLocal(null);
    setDismissed(answer);
  };
  const link = (target: string, chartId: string, text: string) => (
    <a
      href={`#${target}`}
      onClick={(e) => {
        e.preventDefault();
        setSelected(chartId);
        setTimeout(() => document.getElementById(target)?.focus());
      }}
    >
      {text}
    </a>
  );
  const pick = (c: Condition, set: (c: Condition) => void) =>
    "ids" in c &&
    shopify
      .resourcePicker({
        type: c.field === "product" ? "product" : "collection",
        action: "select",
        multiple: true,
        selectionIds: c.ids.map((id) => ({ id })),
      })
      .then((got) => got && set({ ...c, ids: got.map((r) => r.id) }))
      .catch(() =>
        shopify.toast.show("The picker didn't open. Try again.", {
          isError: true,
        }),
      );
  const button = (label: string, onClick: () => void) => (
    <s-button slot="secondary-actions" onClick={onClick}>
      {label}
    </s-button>
  );

  if (loaded.damaged && !redo)
    return (
      <s-page>
        <div className="editor">
          {props.heading}
          <Banner copy={COPY.damaged}>
            <ul className="list">
              {Object.entries(loaded.damaged).map(([path, message]) => {
                const chart = name(path.split(".")[1] ?? "");
                return (
                  <li key={path}>
                    {chart && <strong>{chart}: </strong>}
                    {chart ? lower(message) : message}
                  </li>
                );
              })}
            </ul>
            <s-paragraph>
              <strong>Set up your rules again and save to replace them.</strong>
            </s-paragraph>
            {button("Set up rules again", () => setRedo(true))}
          </Banner>
          <p className="help">
            Not sure what changed them? Email [SUPPORT EMAIL] and we&apos;ll
            look into it.
          </p>
        </div>
      </s-page>
    );

  const plan = err?.code === "plan";
  const listed = plan
    ? []
    : model.problems(draft, errors, loaded.charts, current);
  const paid = plan ? Object.keys(errors)[0]?.split(".") : undefined;
  const paidField = paid
    ? draft.charts[paid[1]]?.[paid[2] as List]?.[Number(paid[3])]?.field
    : undefined;
  const retry = retried ? retryApply : save;
  const banners = (
    <>
      {listed.length > 0 && (
        <Banner
          copy={[
            `Fix ${listed.length} condition${listed.length === 1 ? "" : "s"} to save`,
            "Nothing was saved, so products still show the same charts.",
          ]}
        >
          <ul className="list">
            {listed.map((p, i) => (
              <li key={i}>
                {p.chart && `${p.chart}: `}
                {p.target ? link(p.target, p.chartId!, p.where) : p.where}
                {p.text}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {err?.code === "conflict" && (
        <Banner copy={COPY.conflict}>
          {button("Reload latest", () => revalidator.revalidate())}
          {button("Cancel", dismiss)}
        </Banner>
      )}
      {(err?.code === "product_access" || err?.code === "shopify") && (
        <Banner copy={COPY[err.code]}>
          {button("Try saving again", retry)}
        </Banner>
      )}
      {paid && (
        <Banner
          copy={[
            "This change needs the Standard plan",
            ...(err?.checkFailed
              ? [
                  "Couldn't check your plan, so Fitted uses the last one it confirmed, Free.",
                ]
              : []),
            "On Free, tag, product type, vendor and metafield conditions keep working but can't be added or changed, so nothing was saved.",
          ]}
        >
          <s-paragraph>
            <strong>
              Change the{" "}
              {link(
                model.elementId(paid.join(".")),
                paid[1],
                `${lower(model.LABELS[paidField ?? "tag"])} condition`,
              )}{" "}
              back or remove it, or move to Standard, $9 a month.
            </strong>
          </s-paragraph>
          <s-button
            slot="secondary-actions"
            href={plans(loaded.store)}
            target="_top"
          >
            See plans
          </s-button>
        </Banner>
      )}
      {applying ? (
        <Banner
          tone="info"
          copy={[
            `Applying your rules to ${loaded.products?.toLocaleString("en-US") ?? "your"} products`,
            "Products switch charts over the next few minutes, even if you leave this page.",
            "If you save again, Fitted applies the newer rules right after.",
          ]}
        />
      ) : (
        job?.status === "failed" && (
          <Banner
            copy={[
              "Your rules didn't finish applying",
              `They're saved, but ${reason(job.error)}, so some products still show their old chart. Fitted tries again within a few minutes.`,
            ]}
          >
            {button("Try again", retryApply)}
          </Banner>
        )
      )}
    </>
  );

  const conditions = (list: List) =>
    rule[list].map((c, i) => {
      const p = `charts.${current}.${list}.${i}`;
      const set = (next: Condition) =>
        setList(
          list,
          rule[list].map((x, j) => (j === i ? next : x)),
        );
      return (
        <ConditionRow
          key={i}
          c={c}
          path={p}
          errors={errors}
          message={
            plan && errors[p]
              ? "On Free, change it back or remove it."
              : undefined
          }
          free={loaded.free}
          exclude={list === "exclude"}
          onChange={set}
          onPick={() => pick(c, set)}
          onRemove={() =>
            setList(
              list,
              rule[list].filter((_, j) => j !== i),
            )
          }
        />
      );
    });
  const add = (list: List) => (
    <s-button
      onClick={() => setList(list, [...rule[list], model.blank("collection")])}
    >
      Add condition
    </s-button>
  );
  const unranked = loaded.charts.filter((c) => !draft.order.includes(c.id));

  return (
    <s-page>
      <SaveBar
        id="rules-save-bar"
        open={
          saving ||
          JSON.stringify(model.toSave(draft)) !==
            JSON.stringify(model.toSave(initial))
        }
      >
        <button
          variant="primary"
          onClick={save}
          loading={saving ? "" : undefined}
        >
          Save
        </button>
        <button
          disabled={saving}
          onClick={() => {
            setDraft(initial);
            dismiss();
          }}
        >
          Discard
        </button>
      </SaveBar>
      <div className="editor">
        {banners}
        {props.heading}
        <section className="card" aria-labelledby="rule">
          <div className="row">
            <h2 id="rule">{name(current)}</h2>
            <Link to={`/app/charts/${current.split("/").pop()}`}>
              Edit chart
            </Link>
          </div>
          <p className="lead">
            Show this chart on products that match any of these
          </p>
          {conditions("match")}
          {add("match")}
          {loaded.free && (
            <p className="help">
              On Free, new conditions can use Collection or Specific products.
              The others need{" "}
              <a href={plans(loaded.store)} target="_top">
                Standard
              </a>
              .
            </p>
          )}
          <p className="lead">Never show it on</p>
          {conditions("exclude")}
          {add("exclude")}
          <s-checkbox
            label="Apply to new products automatically"
            details="Any new product that matches gets this chart, with no extra setup."
            checked={rule.auto}
            onChange={(e) =>
              setRule(current, {
                ...rule,
                auto: (e.currentTarget as unknown as { checked: boolean })
                  .checked,
              })
            }
          />
        </section>
        <section className="card" aria-labelledby="priority">
          <div>
            <h2 id="priority">When more than one chart matches</h2>
            <p className="help">
              The chart highest in this list wins. Drag to reorder.
            </p>
          </div>
          <ol className="ranks">
            {draft.order.map((id, i) => (
              <li
                key={id}
                draggable
                onDragStart={() => setDragging(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => move(dragging, i)}
              >
                {/* The arrow keys move it too, for keyboards. */}
                <button
                  type="button"
                  className="handle"
                  aria-label={`Move ${name(id)}`}
                  onKeyDown={(e) => {
                    const to = e.key === "ArrowUp" ? i - 1 : i + 1;
                    if (!["ArrowUp", "ArrowDown"].includes(e.key)) return;
                    e.preventDefault();
                    move(i, to);
                  }}
                >
                  <s-icon type="drag-handle" />
                </button>
                <button
                  type="button"
                  aria-pressed={id === current}
                  onClick={() => setSelected(id)}
                >
                  {i + 1}. {name(id)}
                </button>
                {draft.charts[id].match.some((c) => c.field === "all") && (
                  <span className="help">Everything else</span>
                )}
              </li>
            ))}
          </ol>
          {unranked.length > 0 && draft.order.length < model.MAX_CHARTS && (
            <label>
              Add rules to another chart
              <select
                className="field"
                value=""
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">Pick a chart</option>
                {unranked.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>
      </div>
    </s-page>
  );
}

function ConditionRow(props: {
  c: Condition;
  path: string;
  errors: FieldErrors;
  message?: string;
  free: boolean;
  exclude: boolean;
  onChange: (c: Condition) => void;
  onPick: () => void;
  onRemove: () => void;
}) {
  const { c, path, onChange } = props;
  const e = (part: string) => props.errors[part ? `${path}.${part}` : path];
  const attrs = (part: string, bad = e(part)) => ({
    id: model.elementId(`${path}.${part}`),
    className: bad ? "field bad" : "field",
    "aria-invalid": bad ? true : undefined,
  });
  const message = [props.message, e(""), e("key"), e("value"), e("ids")].find(
    Boolean,
  );
  const noun = c.field === "product" ? "product" : "collection";
  const n = "ids" in c ? c.ids.length : 0;
  return (
    <div>
      <div className="cond">
        <select
          {...attrs("field", e(""))}
          aria-label="Field"
          value={c.field}
          onChange={(ev) =>
            onChange(model.blank(ev.target.value as model.Field, c))
          }
        >
          {model.FIELDS.filter((f) => !(props.exclude && f === "all")).map(
            (f) => (
              <option key={f} value={f}>
                {model.LABELS[f]}
                {props.free && model.PAID.includes(f) ? " (Standard)" : ""}
              </option>
            ),
          )}
        </select>
        {"key" in c && (
          <input
            {...attrs("key")}
            aria-label="Metafield key"
            placeholder="custom.fit"
            value={c.key}
            onChange={(ev) => onChange({ ...c, key: ev.target.value })}
          />
        )}
        {"op" in c && (
          <select
            {...attrs("op")}
            aria-label="Condition"
            value={c.op}
            onChange={(ev) =>
              onChange({ ...c, op: ev.target.value } as Condition)
            }
          >
            {model.opsFor(c.field).map((o) => (
              <option key={o} value={o}>
                {o.replace("_", " ")}
              </option>
            ))}
          </select>
        )}
        {"value" in c && (
          <input
            {...attrs("value")}
            aria-label="Value"
            value={c.value}
            onChange={(ev) => onChange({ ...c, value: ev.target.value })}
          />
        )}
        {"ids" in c && (
          <span className={`${attrs("ids").className} picked`}>
            {n
              ? `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`
              : "None picked yet"}
            <button
              type="button"
              id={model.elementId(`${path}.value`)}
              aria-label={`Edit the picked ${noun}s`}
              onClick={props.onPick}
            >
              Edit
            </button>
          </span>
        )}
        <s-button
          variant="tertiary"
          icon="x"
          accessibilityLabel="Remove condition"
          onClick={props.onRemove}
        />
      </div>
      {message && <p className="err">{message}</p>}
    </div>
  );
}
