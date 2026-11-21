// The Editor board (Fitted canvas): name, template, status, and the tabs: the
// size tables with their tools, units and notes, How to measure, Fit tips and
// Media, saved through App Bridge's save bar, with the live preview beside
// them.
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Link,
  useBlocker,
  useFetcher,
  useNavigate,
  useRevalidator,
} from "react-router";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import type { FieldErrors, Template } from "../../models/chart.server";
import { ChartTable } from "./ChartTable";
import { PasteDialog } from "./PasteDialog";
import { MeasureTab, useMeasureImage } from "./MeasureTab";
import { ChartPreview, type Look } from "../chart-preview/ChartPreview";
import { VIDEO_ERROR, videoSite } from "../../lib/video";
import * as model from "./model";
import "./editor.css";

const SAVE_BAR = "chart-save-bar";
// Duplicate's answers already toasted, across the editor's rebuilds.
const announced = new WeakSet<object>();
const TABS = {
  table: "Size table",
  measure: "How to measure",
  tips: "Fit tips",
  media: "Media",
};
type Tab = keyof typeof TABS;
// The tab that holds a field the banner links to (model.problems).
const tabOf = (id: string): Tab =>
  id === "tips"
    ? "tips"
    : id === "video"
      ? "media"
      : id.startsWith("m-")
        ? "measure"
        : "table";

/** What the action answers (ARCHITECTURE §15). */
type Answer = {
  ok?: true;
  fieldErrors?: FieldErrors;
  /** The fieldErrors are the stored chart's, found on load. */
  stored?: true;
  error?: {
    code: string;
    message: string;
    // plan_limit's numbers and its See plans link
    limit?: number;
    published?: number;
    checkFailed?: boolean;
    plansUrl?: string;
  };
  updatedAt?: string;
  /** The edits saved, the status didn't, and history missed the save. */
  historyMissed?: true;
  /** A new chart's id, once it's created. */
  created?: string;
  /** Duplicate's copy, once it's made. */
  duplicated?: string;
};

export function Editor(props: {
  /** The stored chart; the route remounts the editor when it reloads. */
  initial: model.Draft;
  updatedAt?: string;
  /** Set for a new chart: the handle its create lands on. */
  handle?: string;
  /** Set when the stored chart fails the checks: the server's findings. */
  invalid?: FieldErrors;
  /**
   * The last save landed, but its version history didn't (§5). Kept by the
   * route: a save that lands reloads the chart, which remounts the editor.
   */
  historyMissed?: boolean;
  /** The stored How to measure image's address. */
  imageUrl?: string;
  /** What the live preview draws with besides the draft. */
  look?: Look;
  /**
   * The handle Duplicate's copy lands on, kept by the route while the chart
   * stays open, through this editor's rebuild on each save.
   */
  copyHandle?: string;
  /**
   * The chart's shareable page (§5). Until that page ships (#214), the route
   * passes none, so Copy link is greyed out.
   */
  link?: string;
}) {
  const { invalid, link, copyHandle } = props;
  // A reload mints a new handle (the loader), but the visit keeps its first,
  // so a create retried after one still lands on one chart (§5).
  const [handle] = useState(props.handle);
  const fetcher = useFetcher<Answer>();
  // Keyed by its handle, so a duplicate still on its way when a save
  // rebuilds the editor reaches the rebuilt one and opens the copy.
  const dup = useFetcher<Answer>({ key: `duplicate-${copyHandle}` });
  const [linkBox, setLinkBox] = useState(false);
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const [draft, setDraft] = useState(props.initial);
  const [pasting, setPasting] = useState(false);
  const [tab, setTab] = useState<Tab>("table");
  const [at, setAt] = useState(0);
  const drawing = useMeasureImage(draft.measureImage, props.imageUrl, (id) =>
    setDraft((d) => {
      const next = { ...d, measureImage: id };
      // Removed, it matches a chart stored without one.
      if (!id) delete next.measureImage;
      return next;
    }),
  );
  // The editor's own check, or the action's answer until it's dismissed. A
  // stored chart that fails the checks opens with them, in the editor's words
  // where it has them. A number in a column that isn't a measurement isn't
  // one to fix: the save leaves it out, and the drop warning names it unless
  // the cell's words already hold it.
  const [opened] = useState<Answer | null>(() => {
    if (!invalid) return null;
    const own = model.toInput(props.initial);
    const mine = "fieldErrors" in own ? own.fieldErrors : {};
    const rest = Object.entries(invalid).filter(([k]) => {
      const m = /^content\.tables\.(\d+)\.rows\.\d+\.cells\.(.+)$/.exec(k);
      const cols = props.initial.content.tables[Number(m?.[1])]?.columns;
      return !m || cols?.find((c) => c.id === m[2])?.kind === "measure";
    });
    const all = { ...Object.fromEntries(rest), ...mine };
    return Object.keys(all).length ? { stored: true, fieldErrors: all } : null;
  });
  const [local, setLocal] = useState(opened);
  const [dismissed, setDismissed] = useState<Answer>();
  // What's stored. A save that writes the edits but not the status hands back
  // the new updatedAt without a reload: the sent edits are stored from then on.
  const [base, setBase] = useState({
    initial: props.initial,
    updatedAt: props.updatedAt,
  });
  const { initial } = base;
  const sent = useRef(draft);
  const saving = fetcher.state !== "idle";
  const answer = saving ? undefined : fetcher.data;
  if (answer?.updatedAt && answer.updatedAt !== base.updatedAt)
    setBase({
      initial: { ...sent.current, status: initial.status },
      updatedAt: answer.updatedAt,
    });
  const notice = local ?? (answer === dismissed ? undefined : answer);
  const errors = notice?.fieldErrors ?? {};
  const listed = model.problems(draft, errors);
  // The table being edited goes first in `view`, for the table tools.
  const tables = draft.content.tables;
  const ti = Math.min(at, tables.length - 1);
  const view = model.focus(draft, ti);
  const edit = (d: model.Draft) => setDraft(model.focus(d, ti));
  const t = view.content.tables[0];
  const video = draft.content.videoUrl ?? "";
  const site = videoSite(video.trim());
  const set = (patch: Partial<model.Draft>) => setDraft({ ...draft, ...patch });
  const created = answer?.created;
  const dirty =
    !created && (saving || JSON.stringify(draft) !== JSON.stringify(initial));
  // The save bar holds the admin's links but not the app's own (App Bridge's
  // Save Bar API), so a link out of the editor asks the admin first: on the
  // dev store it shakes the save bar and stays until Save or Discard. A save's
  // redirect isn't a link, so it isn't held.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let live = true;
    // Staying never settles it; the next click asks again.
    shopify.saveBar
      .leaveConfirmation()
      .then(() => shopify.saveBar.hide(SAVE_BAR))
      .then(() => live && blocker.proceed())
      .catch(() => {
        if (!live) return;
        blocker.reset();
        shopify.toast.show(
          "Couldn't leave this page. Save or discard your edits, then try again.",
          { isError: true },
        );
      });
    return () => {
      live = false;
    };
  }, [blocker, shopify]);

  // While the save bar shows, the admin's address bar ignores the app's route
  // (App Bridge's Navigation API), so a new chart's address waits for it to
  // hide. Replaced, so Back skips the blank chart.
  const missed = answer?.historyMissed;
  useEffect(() => {
    if (!created) return;
    let live = true;
    const open = () =>
      live &&
      navigate(`/app/charts/${created}${missed ? "?history=missed" : ""}`, {
        replace: true,
      });
    // A failed hide still opens the chart; only the address may lag.
    shopify.saveBar.hide(SAVE_BAR).then(open, open);
    return () => {
      live = false;
    };
  }, [created, missed, navigate, shopify]);

  // Duplicate copies the saved chart; the copy opens once it's made, through
  // the save bar's leave check like any link out. A save that settles that
  // check rebuilds the editor, which opens the copy without a second toast.
  const duplicating = dup.state !== "idle";
  const copy = duplicating ? undefined : dup.data;
  const duplicate = () =>
    dup.submit(
      { duplicate: copyHandle ?? null },
      { method: "post", encType: "application/json" },
    );
  useEffect(() => {
    if (!copy?.duplicated) return;
    if (!announced.has(copy)) shopify.toast.show("Chart duplicated");
    announced.add(copy);
    navigate(
      `/app/charts/${copy.duplicated}${copy.historyMissed ? "?history=missed" : ""}`,
    );
  }, [copy, navigate, shopify]);
  // The admin's frame may refuse the clipboard; then the link opens, selected,
  // in a box to copy by hand.
  const copyLink = () =>
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(link!))
      .then(
        () => shopify.toast.show("Link copied"),
        () => setLinkBox(true),
      );

  const save = (d = draft) => {
    setDraft(d);
    const r = model.toInput(d);
    if ("fieldErrors" in r) return setLocal(r);
    setLocal(null);
    sent.current = model.toDraft(r.input, d.status);
    drawing.keep(r.input.measureImage);
    const body = handle
      ? { handle, chart: r.input }
      : { chart: r.input, status: d.status, updatedAt: base.updatedAt };
    fetcher.submit(body as never, {
      method: "post",
      encType: "application/json",
    });
  };
  const dismiss = () => {
    setLocal(null);
    setDismissed(answer);
  };
  // A filled table comes in with the cells Fitted can't read marked, as after
  // a save (the Editor board's "Fix the marked fields").
  const fill = (p: model.Pasted) => {
    const filled = model.replaceTable(view, p);
    const next = model.focus(filled, ti);
    setDraft(next);
    setPasting(false);
    dismiss();
    const r = model.toInput(next);
    const marked =
      "fieldErrors" in r
        ? Object.fromEntries(
            Object.entries(r.fieldErrors).filter(([k]) => k !== "name"),
          )
        : {};
    if (Object.keys(marked).length) setLocal({ fieldErrors: marked });
    const t0 = filled.content.tables[0];
    setTimeout(() =>
      document
        .getElementById(`cell-${t0.rows[0].id}-${t0.columns[0].id}`)
        ?.focus(),
    );
  };
  const err = notice?.error;
  const action = (label: string, onClick: () => void) => (
    <s-button slot="secondary-actions" onClick={onClick}>
      {label}
    </s-button>
  );
  // The Editor board's banner for each answer: heading, lines, actions.
  const publishing = draft.status === "ACTIVE";
  const still = `Edits saved, but the chart is still ${initial.status === "ACTIVE" ? "Published" : "a Draft"}`;
  const tryStatus = action(
    `Try ${publishing ? "publishing" : "unpublishing"} again`,
    () => save(),
  );
  const banners: Record<string, [string, string[], ReactNode]> = {
    conflict: [
      "Chart changed since you opened it",
      [
        "Your edits weren't saved, so nothing was overwritten.",
        "Reload latest shows the newest version and discards your edits.",
      ],
      <>
        {action("Reload latest", () => revalidator.revalidate())}
        {action("Cancel", dismiss)}
      </>,
    ],
    plan_limit: [
      `${initial.name} wasn't published`,
      [
        ...(err?.checkFailed
          ? ["Couldn't check your plan, so Fitted counts it as Free."]
          : []),
        `The Free plan allows ${err?.limit} published charts and you have ${err?.published}, so nothing was saved.`,
        "Save it as a Draft, or see plans to publish more.",
      ],
      <>
        {/* A new tab: the admin's save bar holds this one while there are unsaved edits. */}
        {err?.plansUrl && (
          <s-button
            slot="secondary-actions"
            href={err.plansUrl}
            target="_blank"
          >
            See plans
          </s-button>
        )}
        {action("Save as Draft", () => save({ ...draft, status: "DRAFT" }))}
      </>,
    ],
    status: [
      still,
      [
        publishing
          ? `Shopify didn't publish ${initial.name}, so shoppers can't see it yet.`
          : `Shopify didn't unpublish ${initial.name}, so shoppers can still see it.`,
      ],
      tryStatus,
    ],
    // The Rules board's "No access to products" wording.
    product_access: [
      still,
      [
        `You need Products access to ${publishing ? "publish" : "unpublish"} charts, since that also updates your products.`,
        "Ask the store owner to add Products access to your account in Settings › Users.",
      ],
      tryStatus,
    ],
  };
  const [heading, lines, actions] = (err && banners[err.code]) ?? [
    "Your changes weren't saved",
    [
      "Shopify didn't respond in time, so the chart on your store hasn't changed. Your edits are still here.",
    ],
    action("Try saving again", () => save()),
  ];
  const n = listed.length;
  // Once a save is stored, the numbers are gone, even when only the status
  // failed and the editor stays open.
  const drops = base.updatedAt === props.updatedAt ? model.dropped(draft) : [];
  const badVideo = !!video.trim() && !site;
  // Findings left after a remove; with none, the banner goes, as after a fix
  // and save.
  const settle = (left: FieldErrors) =>
    Object.keys(left).length
      ? setLocal({ ...notice, fieldErrors: left })
      : dismiss();

  // The Editor board's "Editing table 2". A new or cloned table opens.
  const full = tables.length >= model.MAX_TABLES;
  const title = (i: number) => model.tableTitle(draft, i);
  const clone = (i: number) => {
    setDraft(model.cloneTable(draft, i));
    setAt(tables.length);
  };
  const word = (key: string, name: string) => (
    <label className="grow">
      {name}
      <input
        id={key.replace(".", "-")}
        className="field"
        maxLength={500}
        value={draft.content.words[key] ?? ""}
        onChange={(e) => setDraft(model.setWord(draft, key, e.target.value))}
      />
    </label>
  );
  const tableHead = (
    <>
      <div className="row">
        <div role="group" aria-label="Tables in this chart" className="segs">
          {tables.map((x, i) => (
            <button
              key={x.id}
              type="button"
              aria-pressed={i === ti}
              onClick={() => setAt(i)}
            >
              {`${i + 1}. ${title(i) || `Table ${i + 1}`}`}
            </button>
          ))}
        </div>
        <div className="row start">
          <button
            type="button"
            className="btn2"
            disabled={full}
            onClick={() => clone(ti)}
          >
            Clone table
          </button>
          <button
            type="button"
            className="btn2 danger"
            disabled={!model.canRemoveTable(draft, ti)}
            onClick={() => {
              const errs = notice?.fieldErrors;
              setDraft(model.removeTable(draft, ti));
              setAt(ti - 1);
              if (errs) settle(model.removeTableErrors(draft, ti, errs));
            }}
          >
            Remove table
          </button>
        </div>
      </div>
      <div className="row">
        {word(`${t.id}.title`, "Heading")}
        {word(`${t.id}.sub`, "Line under the heading")}
      </div>
    </>
  );

  return (
    <s-page>
      <SaveBar id={SAVE_BAR} open={dirty}>
        {/* A save remounts the editor, which would drop the upload. */}
        <button
          variant="primary"
          onClick={() => save()}
          loading={saving ? "" : undefined}
          disabled={drawing.sending}
        >
          Save
        </button>
        <button
          disabled={saving}
          onClick={() => {
            setDraft(initial);
            drawing.reset();
            dismiss();
            // The opening findings hold only until a save stores new content.
            setLocal(base.updatedAt === props.updatedAt ? opened : null);
          }}
        >
          Discard
        </button>
      </SaveBar>
      <div className="editor split">
        {((props.historyMissed && !answer) || answer?.historyMissed) && (
          <s-banner
            tone="warning"
            heading="Saved, but version history missed it"
          >
            <s-paragraph>
              The chart on your store is up to date. This save won&apos;t show
              in version history.
            </s-paragraph>
          </s-banner>
        )}
        {notice?.fieldErrors && (
          <s-banner
            tone="critical"
            heading={
              notice.stored
                ? `Fix ${n} ${n === 1 ? "value" : "values"} to save this chart`
                : `Fix ${n} ${listed.every((p) => p.short) ? "cell" : "field"}${n === 1 ? "" : "s"} to save`
            }
          >
            <s-paragraph>
              {notice.stored
                ? "They were changed outside Fitted. Nothing on your store has changed."
                : "Nothing was saved, so your store hasn't changed."}
            </s-paragraph>
            <ul className="list">
              {listed.map((p, i) => (
                <li key={p.id ?? i}>
                  {p.id ? (
                    <a
                      href={`#${p.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        setTab(tabOf(p.id!));
                        if (tabOf(p.id!) === "table") setAt(p.table);
                        setTimeout(() =>
                          document.getElementById(p.id!)?.focus(),
                        );
                      }}
                    >
                      {p.where}
                    </a>
                  ) : (
                    p.where
                  )}
                  {p.short ? ` ${p.short}` : `${p.where && ": "}${p.long}`}
                </li>
              ))}
            </ul>
          </s-banner>
        )}
        {err && (
          <s-banner tone="critical" heading={heading}>
            {lines.map((l) => (
              <s-paragraph key={l}>{l}</s-paragraph>
            ))}
            {actions}
          </s-banner>
        )}
        {drops.map((x) => (
          <s-banner key={x.col} tone="warning" heading={x.heading}>
            <s-paragraph>{x.text}</s-paragraph>
            <s-paragraph>
              <strong>{x.fix}</strong>
            </s-paragraph>
          </s-banner>
        ))}
        {copy && !copy.duplicated && (
          <s-banner
            tone="critical"
            heading={`${initial.name} wasn't duplicated`}
          >
            <s-paragraph>
              Shopify didn&apos;t respond, so no copy was made.
            </s-paragraph>
            {action("Try again", duplicate)}
          </s-banner>
        )}
        <div className="row">
          <div>
            <Link to="/app/charts">Size charts</Link>
            <div className="row">
              <h1>{handle ? "New chart" : initial.name}</h1>
              {!handle && (
                <select
                  className="field auto"
                  aria-label="Chart status"
                  value={draft.status}
                  onChange={(e) =>
                    set({ status: e.target.value as model.Draft["status"] })
                  }
                >
                  <option value="ACTIVE">Published</option>
                  <option value="DRAFT">Draft</option>
                </select>
              )}
            </div>
          </div>
          {!handle &&
            (duplicating ? (
              <button type="button" className="btn2" disabled aria-busy="true">
                <svg
                  className="spin"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="8.5" stroke="#E1E3E5" />
                  <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" stroke="#202223" />
                </svg>
                Duplicating
              </button>
            ) : (
              <details className="more">
                <summary className="btn2">More actions</summary>
                <div className="menu">
                  <Link to="history">Version history</Link>
                  <button
                    type="button"
                    disabled={!link}
                    onClick={(e) => {
                      e.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      void copyLink();
                    }}
                  >
                    Copy link
                    {link && initial.status === "DRAFT" && (
                      <span>Works once the chart is published</span>
                    )}
                  </button>
                  {/* A chart that fails the checks can't be copied until it's fixed. */}
                  <button
                    type="button"
                    disabled={!!invalid}
                    onClick={duplicate}
                  >
                    Duplicate
                  </button>
                </div>
              </details>
            ))}
          {linkBox && (
            <dialog
              className="confirm"
              aria-labelledby="link-heading"
              ref={(el) => {
                if (!el || el.open) return;
                el.showModal();
                const field = el.querySelector("input");
                field?.focus();
                field?.select();
              }}
              onClose={() => setLinkBox(false)}
            >
              <div className="head">
                <h2 id="link-heading">Copy this link</h2>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setLinkBox(false)}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                  >
                    <path
                      d="M5 5l10 10M15 5L5 15"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                  </svg>
                </button>
              </div>
              <div className="body">
                <p>
                  Your browser didn&apos;t let Fitted copy it. Select the link
                  and copy it yourself.
                </p>
                <label>
                  Link to {initial.name}
                  <input className="field" readOnly value={link} />
                </label>
              </div>
              <div className="foot">
                <s-button variant="primary" onClick={() => setLinkBox(false)}>
                  Done
                </s-button>
              </div>
            </dialog>
          )}
        </div>
        <section className="card" aria-label="Chart content">
          <div className="row">
            <label className="grow">
              Chart name
              <input
                id="name"
                className={errors.name ? "field bad" : "field"}
                placeholder="For example, Women's tops"
                aria-invalid={errors.name ? true : undefined}
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <label className="grow">
              Template
              <select
                className="field"
                value={draft.template}
                onChange={(e) =>
                  setDraft(
                    model.pickTemplate(draft, e.target.value as Template),
                  )
                }
              >
                {Object.entries(model.TEMPLATES).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="tabs">
            {Object.entries(TABS).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="tab"
                aria-pressed={tab === id}
                onClick={() => setTab(id as Tab)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "measure" && (
            <MeasureTab
              draft={draft}
              drawing={drawing.box}
              onChange={setDraft}
            />
          )}
          {tab === "tips" && (
            <div>
              <label>
                Fit tips
                <textarea
                  id="tips"
                  className="field"
                  rows={5}
                  maxLength={2000}
                  placeholder="For example, Runs small through the shoulders. Size up if you're between sizes."
                  value={draft.content.words.tips ?? ""}
                  onChange={(e) =>
                    setDraft(model.setWord(draft, "tips", e.target.value))
                  }
                />
              </label>
              <div className="row">
                <span className="help">
                  Shoppers see these under the size table.
                </span>
                <span className="help">
                  {(draft.content.words.tips ?? "").length.toLocaleString(
                    "en-US",
                  )}{" "}
                  of 2,000 characters
                </span>
              </div>
            </div>
          )}
          {tab === "media" && (
            <div className="col">
              <label>
                Fit video
                <input
                  id="video"
                  type="url"
                  className={badVideo ? "field bad" : "field"}
                  aria-invalid={badVideo || undefined}
                  aria-describedby={badVideo ? "video-err" : undefined}
                  value={video}
                  onChange={(e) =>
                    setDraft(model.setVideo(draft, e.target.value))
                  }
                />
              </label>
              {badVideo ? (
                <div id="video-err" className="fielderr">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7.5v5.5M12 16.5v.01" />
                  </svg>
                  <span>{VIDEO_ERROR}</span>
                </div>
              ) : (
                <p className="help">A YouTube or Vimeo link, one per chart.</p>
              )}
              {site && (
                <div className="video">
                  <div className="thumb" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                  <div className="grow">
                    <strong>{site} video</strong>
                    <div className="help">Plays inside the size guide.</div>
                  </div>
                  <button
                    type="button"
                    className="btn2"
                    onClick={() => setDraft(model.setVideo(draft, ""))}
                  >
                    Remove video
                  </button>
                </div>
              )}
            </div>
          )}
          {tab === "table" && (
            <>
              <div className="row">
                <div role="group" aria-label="Units" className="segs">
                  {(["in", "cm"] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      aria-pressed={draft.content.unit === u}
                      onClick={() => setDraft(model.setUnit(draft, u))}
                    >
                      {u}
                    </button>
                  ))}
                </div>
                <s-stack direction="inline" gap="small-200">
                  <s-button
                    disabled={t.rows.length >= model.MAX_ROWS}
                    onClick={() => edit(model.addSize(view))}
                  >
                    Add size
                  </s-button>
                  <s-button
                    disabled={t.columns.length >= model.MAX_COLUMNS}
                    onClick={() => edit(model.addMeasurement(view))}
                  >
                    Add measurement
                  </s-button>
                </s-stack>
              </div>
              {ti > 0 && !t.rows.length && tableHead}
              {t.rows.length ? (
                <ChartTable
                  key={t.id}
                  draft={view}
                  errors={model.focusErrors(errors, ti)}
                  problems={listed.filter((p) => p.table === ti)}
                  dropped={drops.flatMap((x) => x.cells)}
                  onChange={edit}
                  onPaste={() => setPasting(true)}
                  onRemove={(sel) => {
                    edit(model.remove(view, sel));
                    // Cell findings name sizes by position, so they move up too.
                    if (!notice?.fieldErrors) return;
                    const left = model.focusErrors(
                      model.removeErrors(
                        view,
                        sel,
                        model.focusErrors(notice.fieldErrors, ti),
                      ),
                      ti,
                    );
                    settle(left);
                  }}
                  head={ti > 0 && tableHead}
                />
              ) : (
                <div className="blank">
                  <svg
                    width="56"
                    height="56"
                    viewBox="0 0 48 48"
                    fill="none"
                    stroke="#2448A8"
                    strokeLinecap="square"
                    aria-hidden="true"
                  >
                    <path
                      d="M10 40V10h30"
                      strokeWidth="3"
                      strokeDasharray="4 3"
                    />
                    <path d="M17 40V17h23" strokeWidth="6" />
                    <path d="M24 40V24h16" strokeWidth="3" />
                  </svg>
                  <h2>A blank chart, ready for sizes</h2>
                  <p className="help">
                    Paste a whole table from a spreadsheet or supplier sheet and
                    Fitted fills in the sizes and measurements. Or pick a
                    template above.
                  </p>
                  <s-button variant="primary" onClick={() => setPasting(true)}>
                    Paste whole chart
                  </s-button>
                </div>
              )}
              {pasting && (
                <PasteDialog onClose={() => setPasting(false)} onFill={fill} />
              )}
              <p className="help">
                Type in inches or centimeters. Fitted converts the other unit
                for shoppers automatically.
              </p>
              {ti === 0 &&
                tables.slice(1).map((x, j) => (
                  <div key={x.id} className="tablerow">
                    <div>
                      <strong>
                        {`Table ${j + 2}${title(j + 1) && `: ${title(j + 1)}`}`}
                      </strong>
                      <div className="help">
                        {model.measuresOf(draft, j + 1)
                          ? `${model.measuresOf(draft, j + 1)}, shown under its own heading in the same chart`
                          : "Shown under its own heading in the same chart"}
                      </div>
                    </div>
                    <div className="row start">
                      <button
                        type="button"
                        className="btn2"
                        disabled={full}
                        onClick={() => clone(j + 1)}
                      >
                        Clone table
                      </button>
                      <button
                        type="button"
                        className="btn2"
                        onClick={() => setAt(j + 1)}
                      >
                        Edit table
                      </button>
                    </div>
                  </div>
                ))}
              <div className="row start">
                <button
                  type="button"
                  className="btn2"
                  disabled={full}
                  onClick={() => {
                    setDraft(model.addTable(draft));
                    setAt(tables.length);
                  }}
                >
                  Add another table
                </button>
                {ti > 0 && (
                  <span className="help">
                    A chart holds up to 4 tables. Shoppers see them in order,
                    each under its heading.
                  </span>
                )}
              </div>
              <label>
                Note under the table
                <textarea
                  className="field"
                  rows={2}
                  value={draft.content.words[`${t.id}.note`] ?? ""}
                  onChange={(e) =>
                    setDraft(
                      model.setWord(draft, `${t.id}.note`, e.target.value),
                    )
                  }
                />
              </label>
              {/* The same drawing as How to measure's, shown there. */}
              <div className="boxes">
                <button
                  type="button"
                  className="drop"
                  onClick={() => {
                    setTab("measure");
                    drawing.open();
                  }}
                >
                  <strong>How-to-measure image</strong>
                  <span className="help">
                    PNG or JPG, shown in the How to measure tab
                  </span>
                </button>
                {/* The same link as the Media tab's, edited there. */}
                <button
                  type="button"
                  className="drop"
                  onClick={() => {
                    setTab("media");
                    setTimeout(() => document.getElementById("video")?.focus());
                  }}
                >
                  <strong>Fit video</strong>
                  <span className="help">Paste a YouTube or Vimeo link</span>
                </button>
              </div>
            </>
          )}
          {drawing.input}
        </section>
        {props.look && (
          <ChartPreview
            draft={draft}
            look={props.look}
            image={drawing.url}
            tab={tab}
          />
        )}
      </div>
    </s-page>
  );
}
