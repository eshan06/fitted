// The Rules board (Fitted canvas): one chart's conditions, the priority list,
// and the save through App Bridge's save bar, which starts a resolve.
import { useState } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import type { Condition, FieldErrors, Rules } from "../../models/rules.server";
import * as model from "./model";
import "./rules.css";

export type Loaded = {
  charts: model.ChartInfo[];
  rules: Rules;
  digest: string | null;
  damaged: FieldErrors | null;
};
type Answer = {
  ok?: true;
  fieldErrors?: FieldErrors;
  error?: { code: string };
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
export function Banner(props: { copy: string[]; children?: React.ReactNode }) {
  const [heading, ...lines] = props.copy;
  return (
    <s-banner tone="critical" heading={heading}>
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
  const revalidator = useRevalidator();
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
  // Newer rules loaded (a save, Reload latest): they replace the edits.
  if (loaded.digest !== base.digest) {
    const initial = model.forCharts(loaded.rules, ids);
    setBase({ digest: loaded.digest, initial });
    setDraft(initial);
    setDismissed(fetcher.data);
  }
  const { initial } = base;

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
    const fieldErrors = model.check(rules);
    const bad = Object.keys(fieldErrors).length > 0;
    setLocal(bad ? { fieldErrors } : null);
    const body = { rules, digest: base.digest } as never;
    if (!bad)
      return fetcher.submit(body, {
        method: "post",
        encType: "application/json",
      });
    const [first] = Object.keys(fieldErrors);
    setSelected(first.split(".")[1]);
    setTimeout(() => document.getElementById(model.elementId(first))?.focus());
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

  const banners = (
    <>
      {/* A valid save with the loaded digest replaces them (§6). */}
      {loaded.damaged && (
        <Banner
          copy={[
            ...COPY.damaged,
            "**Set up your rules again and save to replace them.",
          ]}
        />
      )}
      {marked.length > 0 && (
        <Banner
          copy={[
            `Fix ${marked.length} condition${marked.length === 1 ? "" : "s"} to save`,
            "Nothing was saved, so products still show the same charts.",
            // Messages about the whole document, such as a limit (§6).
            ...marked
              .filter(([p]) => !p.startsWith("charts."))
              .map(([, m]) => m),
          ]}
        />
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
  const message = [e(""), e("key"), e("value"), e("ids")].find(Boolean);
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
          {model.FIELDS.map((f) => (
            <option key={f} value={f}>
              {model.LABELS[f]}
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
