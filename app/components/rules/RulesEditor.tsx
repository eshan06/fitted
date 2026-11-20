// The Rules board (Fitted canvas): one chart's conditions, the priority list,
// the save through App Bridge's save bar, then the resolve's progress.
import { useEffect, useState } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import type {
  Condition,
  FieldErrors,
  Rules,
  latestResolve,
} from "../../models/rules.server";
import * as model from "./model";
import "./rules.css";

type Job = Awaited<ReturnType<typeof latestResolve>>;
export type Loaded = {
  charts: model.ChartInfo[];
  rules: Rules;
  digest: string | null;
  damaged: string[] | null; // the saved rules' problems
  job: Job;
  products: number | null;
  counts: Record<string, { count: number; atLeast: boolean }> | null;
  names: Record<string, string>; // picked products' and collections' titles
  free: boolean;
  plansUrl: string | null;
};
type Preview = {
  count: number;
  atLeast: boolean;
  products: { id: string; title: string; image: string | null }[];
  url: string;
} | null;
type Answer = {
  ok?: true;
  after?: number; // the newest resolve when this one was asked for
  fieldErrors?: FieldErrors;
  error?: { code: string; message: string };
  checkFailed?: boolean;
  plansUrl?: string | null;
  limits?: ReturnType<typeof model.limits>; // the screen's own
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
  plan: [
    "This change needs the Standard plan",
    "On Free, tag, product type, vendor and metafield conditions keep working but can't be added or changed, so nothing was saved.",
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
  tone?: "info";
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

const NONE: Rule = { match: [], exclude: [], auto: true };

export function RulesEditor(props: {
  loaded: Loaded;
  heading: React.ReactNode;
}) {
  const { loaded } = props;
  const shopify = useAppBridge();
  const fetcher = useFetcher<Answer>();
  const apply = useFetcher<Answer>();
  const poll = useFetcher<{ job: Job; failed?: true }>();
  const preview = useFetcher<{ preview: Preview }>();
  const revalidator = useRevalidator();
  const [redo, setRedo] = useState(false); // Set up rules again
  const ids = new Set(loaded.charts.map((c) => c.id));
  const [base, setBase] = useState({
    digest: loaded.digest,
    initial: model.forCharts(loaded.rules, ids),
  });
  const [draft, setDraft] = useState(base.initial);
  const [local, setLocal] = useState<Answer | null>(null);
  const [dismissed, setDismissed] = useState<Answer>();
  const [selected, setSelected] = useState<string>();
  const [dragging, setDragging] = useState(-1);
  const [names, setNames] = useState(loaded.names);
  const [all, setAll] = useState(false); // Show all, at the chart limit
  // Newer rules loaded (a save, Reload latest): they replace the edits.
  if (loaded.digest !== base.digest) {
    const initial = model.forCharts(loaded.rules, ids);
    setBase({ digest: loaded.digest, initial });
    setDraft(initial);
    setDismissed(fetcher.data);
    setNames((n) => ({ ...n, ...loaded.names }));
  }
  // A server answer marking another chart's condition opens that chart.
  const [shown, setShown] = useState<Answer>();
  if (fetcher.data !== shown) {
    setShown(fetcher.data);
    const [first] = Object.keys(fetcher.data?.fieldErrors ?? {});
    if (first?.startsWith("charts.")) setSelected(first.split(".")[1]);
  }
  const { initial } = base;

  // The resolve a save or Try again started shows as applying until a job
  // newer than the one before it ends; so does a running merchant resolve (§13).
  const polled = poll.data?.job;
  const job =
    polled && polled.at >= (loaded.job?.at ?? 0) ? polled : loaded.job;
  const asked = [fetcher.data, apply.data].filter((a) => a?.ok);
  // Polls that couldn't read the job retry quietly; the third in a row stops
  // them and says the rules didn't finish. A save or Try again starts over.
  const [misses, setMisses] = useState({ data: poll.data, n: 0 });
  if (poll.data !== misses.data)
    setMisses({ data: poll.data, n: poll.data?.failed ? misses.n + 1 : 0 });
  const lost = misses.n >= 3;
  const retry = () => setMisses({ data: poll.data, n: 0 });
  // ponytail: a resolve that never records its job polls until the page closes.
  const applying =
    !lost &&
    ((job?.status === "running" && job.merchant) ||
      asked.some((a) => (job?.at ?? 0) <= a!.after!));
  const { load } = poll;
  useEffect(() => {
    if (!applying) return;
    const t = setInterval(() => load("/app/rules?job"), 3000);
    return () => clearInterval(t);
  }, [applying, load]);
  // Try again's refusals; the didn't-finish banner stays to try once more.
  const refused = apply.state === "idle" && apply.data?.error?.code;
  useEffect(() => {
    if (refused)
      shopify.toast.show(
        refused === "product_access"
          ? "You need Products access to apply rules. Ask the store owner to add it in Settings › Users."
          : "Shopify didn't respond, so the rules weren't applied. Try again.",
        { isError: true },
      );
  }, [refused, apply.data, shopify]);

  const saving = fetcher.state !== "idle";
  const answer = saving ? undefined : fetcher.data;
  const notice = local ?? (answer === dismissed ? undefined : answer);
  const errors = notice?.fieldErrors ?? {};
  const err = notice?.error;
  const marked = Object.entries(errors);
  const name = (id: string) =>
    loaded.charts.find((c) => c.id === id)?.name ?? "";
  const current =
    selected && ids.has(selected)
      ? selected
      : (draft.order[0] ?? loaded.charts[0].id);
  const rule = draft.charts[current] ?? NONE;
  // The chart on screen's matches, again when a resolve starts or ends.
  const { load: show } = preview;
  useEffect(() => {
    show(`/app/rules?preview=${encodeURIComponent(current)}`);
  }, [current, applying, show]);

  const setRule = (id: string, next: Rule) =>
    setDraft((d) => ({
      ...d,
      order: d.order.includes(id) ? d.order : [...d.order, id],
      charts: { ...d.charts, [id]: next },
    }));
  const setList = (list: List, items: Condition[]) => {
    // Marks go by position, so after an add or remove they'd mark other rows.
    if (items.length !== rule[list].length && marked.length) dismiss();
    setRule(current, { ...rule, [list]: items });
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= draft.order.length || from < 0) return;
    const order = [...draft.order];
    order.splice(to, 0, ...order.splice(from, 1));
    setDraft({ ...draft, order });
  };
  const save = () => {
    const rules = model.toSave(draft);
    const limits = model.limits(rules);
    const fieldErrors = { ...model.check(rules), ...limits.errors };
    const bad = Object.keys(fieldErrors).length > 0;
    setLocal(bad ? { fieldErrors, limits } : null);
    const body = { rules, digest: base.digest } as never;
    if (!bad) {
      retry();
      return fetcher.submit(body, {
        method: "post",
        encType: "application/json",
      });
    }
    focus(Object.keys(fieldErrors)[0]);
  };
  // Opens a marked field's chart and moves to the field.
  const focus = (path: string) => {
    setSelected(path.split(".")[1]);
    setTimeout(() => document.getElementById(model.elementId(path))?.focus());
  };
  const dismiss = () => {
    setLocal(null);
    setDismissed(answer);
  };
  const pick = (c: Condition, set: (c: Condition) => void) =>
    "ids" in c &&
    shopify
      .resourcePicker({
        type: c.field === "product" ? "product" : "collection",
        action: "select",
        multiple: true,
        selectionIds: c.ids.map((id) => ({ id })),
      })
      .then((got) => {
        if (!got) return;
        setNames((n) => ({
          ...n,
          ...Object.fromEntries(got.map((r) => [r.id, r.title])),
        }));
        set({ ...c, ids: got.map((r) => r.id) });
      })
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
  // A banner's link to a marked field.
  const link = (path: string, text: string) => (
    <a
      href={`#${model.elementId(path)}`}
      onClick={(e) => {
        e.preventDefault();
        focus(path);
      }}
    >
      {text}
    </a>
  );
  const plan = err?.code === "plan";
  const [paid] = plan ? marked.map(([p]) => p) : [];
  const paidField = model.LABELS[model.at(draft, paid ?? "")?.field ?? "tag"];
  const over = notice?.limits;
  const listed = plan
    ? []
    : model.problems(
        draft,
        Object.fromEntries(marked.filter(([p]) => !over?.errors[p])),
        loaded.charts,
        current,
      );
  // Conditions, not problems: one can have several. At least 1 for a message about the whole document.
  const rows =
    new Set(
      listed.flatMap((l) => l.path?.split(".").slice(0, 4).join(".") ?? []),
    ).size || 1;

  const conditions = (list: List) =>
    rule[list].map((c, i) => {
      const p = `charts.${current}.${list}.${i}`;
      const set = (next: Condition) =>
        setList(
          list,
          rule[list].map((x, j) => (j === i ? next : x)),
        );
      // Free's refusal of a saved paid condition that was edited.
      // Only with nothing added or removed, and the saved one gone from the
      // list, is this row the saved one edited.
      const was = model.at(initial, p);
      const saved = initial.charts[current]?.[list] ?? [];
      const same = (x: Condition) => JSON.stringify(x) === JSON.stringify(was);
      const old =
        was &&
        "value" in was &&
        saved.length === rule[list].length &&
        !rule[list].some(same)
          ? `Was ${was.value}. `
          : "";
      return (
        <ConditionRow
          key={i}
          c={c}
          path={p}
          errors={errors}
          free={loaded.free}
          names={names}
          message={
            plan && errors[p]
              ? `${old}On Free, change it back or remove it.`
              : undefined
          }
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
  const unranked = loaded.charts.filter(
    (c) => c.id !== current && !draft.order.includes(c.id),
  );
  // At the most charts rules rank, the list shortens and each can come off it.
  const full = draft.order.length >= model.MAX_CHARTS;
  const ranks = full && !all ? draft.order.slice(0, 10) : draft.order;
  const takeOff = (id: string) =>
    setDraft((d) => ({
      ...d,
      order: d.order.filter((x) => x !== id),
      charts: Object.fromEntries(
        Object.entries(d.charts).filter(([x]) => x !== id),
      ),
    }));
  // Undefined while it loads, null when Shopify gave none.
  const matches = preview.state === "idle" ? preview.data?.preview : undefined;

  if (loaded.damaged && !redo)
    return (
      <s-page>
        <div className="editor">
          {props.heading}
          <Banner copy={COPY.damaged}>
            <ul className="list">
              {loaded.damaged.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
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

  return (
    <s-page>
      <SaveBar
        id="rules-save-bar"
        open={
          saving ||
          // Rules set up again replace the damaged ones even when empty (§6).
          (redo && !!loaded.damaged) ||
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
            setRedo(false);
            dismiss();
          }}
        >
          Discard
        </button>
      </SaveBar>
      <div className="editor rules">
        {listed.length > 0 && (
          <Banner
            copy={[
              `Fix ${rows} condition${rows > 1 ? "s" : ""} to save`,
              "Nothing was saved, so products still show the same charts.",
            ]}
          >
            <ul className="list">
              {listed.map((p, i) => (
                <li key={i}>
                  {p.path ? link(p.path, p.where) : p.where}
                  {p.text}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        {paid && (
          <Banner
            copy={[
              COPY.plan[0],
              ...(notice?.checkFailed
                ? [
                    "Couldn't check your plan, so Fitted uses the last one it confirmed, Free.",
                  ]
                : []),
              COPY.plan[1],
            ]}
          >
            <s-paragraph>
              Change the {link(paid, `${model.lower(paidField)} condition`)}{" "}
              back or remove it, or move to Standard, $9 a month.
            </s-paragraph>
            {/* A new tab: the admin's save bar holds this one while there are unsaved edits. */}
            {notice?.plansUrl && (
              <s-button
                slot="secondary-actions"
                href={notice.plansUrl}
                target="_blank"
              >
                See plans
              </s-button>
            )}
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
            {button("Try saving again", save)}
          </Banner>
        )}
        {full && (
          <Banner
            tone="info"
            copy={[
              `${draft.order.length} of ${model.MAX_CHARTS} charts ranked`,
              "That's the most rules can rank. To add rules to another chart, take one you don't use off the list below.",
            ]}
          >
            {button("Go to the list", () =>
              document.getElementById("priority")?.scrollIntoView(),
            )}
          </Banner>
        )}
        {over?.metafield && (
          <Banner
            tone="info"
            copy={[
              `${model.MAX_METAFIELDS} of ${model.MAX_METAFIELDS} metafields in use`,
            ]}
          >
            <s-paragraph>
              That&apos;s the most rules can compare, so the{" "}
              {link(over.metafield, "marked condition")} can&apos;t be saved.
              Use a metafield your rules already compare, or a tag, product type
              or vendor.
            </s-paragraph>
          </Banner>
        )}
        {over?.ids && (
          <Banner
            tone="info"
            copy={[
              `${over.ids.total.toLocaleString("en-US")} of ${model.MAX_IDS.toLocaleString("en-US")} products and collections picked`,
            ]}
          >
            <s-paragraph>
              The {link(over.ids.path, "marked condition")} goes over, so it
              can&apos;t be saved. Use a tag (doesn&apos;t count) or a whole
              collection (counts once) instead.
            </s-paragraph>
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
          (lost || job?.status === "failed") && (
            <Banner
              copy={[
                "Your rules didn't finish applying",
                `They're saved, but ${lost ? "Fitted couldn't check its progress" : model.reason(job!.error)}, so some products still show their old chart. Fitted tries again within a few minutes.`,
              ]}
            >
              {button("Try again", () => {
                retry();
                apply.submit({ intent: "apply" } as never, {
                  method: "post",
                  encType: "application/json",
                });
              })}
            </Banner>
          )
        )}
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
              The others need {/* Without its link it reads as plain text. */}
              <a
                href={loaded.plansUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
              >
                Standard
              </a>
              .
            </p>
          )}
          <p className="lead">Never show it on</p>
          {conditions("exclude")}
          {add("exclude")}
          <label className="check">
            <input
              type="checkbox"
              checked={rule.auto}
              onChange={(e) =>
                setRule(current, { ...rule, auto: e.target.checked })
              }
            />
            <span>
              Apply to new products automatically
              <span className="help">
                Any new product that matches gets this chart, with no extra
                setup.
              </span>
            </span>
          </label>
        </section>
        {/* Without a preview Shopify won't give, the card is left out (§15). */}
        {matches !== null && (
          <aside className="card" aria-label="Matching products">
            {!matches ? (
              <div role="status">
                <span className="visually-hidden">
                  Loading matching products
                </span>
                <span className="sk" />
                <span className="sk short" />
              </div>
            ) : (
              <>
                <h2>
                  {matches.count === 1 && !matches.atLeast
                    ? "1 product matches"
                    : `${model.productCount(matches)} match`}
                </h2>
                <ul className="matches">
                  {matches.products.map((p) => (
                    <li key={p.id}>
                      {p.image ? (
                        <img src={p.image} alt="" width={36} height={36} />
                      ) : (
                        <span className="thumb" />
                      )}
                      {p.title}
                    </li>
                  ))}
                </ul>
                {matches.count > 0 && (
                  // A new tab: the admin's save bar holds this one while there are unsaved edits.
                  <a href={matches.url} target="_blank" rel="noreferrer">
                    See all {model.amount(matches)}
                  </a>
                )}
              </>
            )}
          </aside>
        )}
        <section className="card" aria-labelledby="priority">
          <div className="row">
            <div>
              <h2 id="priority">When more than one chart matches</h2>
              <p className="help">
                The chart highest in this list wins. Drag to reorder.
              </p>
            </div>
            {full && (
              <strong>
                {draft.order.length} of {model.MAX_CHARTS} ranked
              </strong>
            )}
          </div>
          <ol className="ranks">
            {ranks.map((id, i) => (
              <li
                key={id}
                draggable
                onDragStart={() => setDragging(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  move(dragging, i);
                  setDragging(-1);
                }}
              >
                {/* The arrow keys move it too, for keyboards. */}
                <button
                  type="button"
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
                  className="name"
                  aria-pressed={id === current}
                  onClick={() => setSelected(id)}
                >
                  {i + 1}. {name(id)}
                </button>
                {draft.charts[id].match.some((c) => c.field === "all") ? (
                  <span className="help">Everything else</span>
                ) : (
                  loaded.counts?.[id] && (
                    <span className="help">
                      {model.productCount(loaded.counts[id])}
                    </span>
                  )
                )}
                {full && (
                  <button
                    type="button"
                    aria-label={`Take ${name(id)} off the list`}
                    onClick={() => takeOff(id)}
                  >
                    <s-icon type="x" />
                  </button>
                )}
              </li>
            ))}
          </ol>
          {full && (
            <div className="row">
              {!all && (
                <s-button onClick={() => setAll(true)}>
                  Show all {draft.order.length}
                </s-button>
              )}
              <span className="help">
                Taking a chart off the list removes its rules. The chart itself
                stays.
              </span>
            </div>
          )}
          {unranked.length > 0 && !full && (
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
  free: boolean;
  names: Record<string, string>;
  message?: string; // in place of the field error
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
  const message = [
    props.message,
    e(""),
    e("key"),
    e("op"),
    e("value"),
    e("ids"),
  ].find(Boolean);
  const noun = c.field === "product" ? "product" : "collection";
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
          {model.FIELDS.map((f) => (
            <option key={f} value={f}>
              {model.LABELS[f]}
              {props.free && model.PAID.includes(f) ? " (Standard)" : ""}
            </option>
          ))}
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
            <span>{model.pickedText(c, props.names)}</span>
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
