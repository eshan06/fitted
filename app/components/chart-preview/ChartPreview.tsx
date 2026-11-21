// The Editor board's live preview (ARCHITECTURE §9): the size guide as
// shoppers see it, drawn by the storefront's own render() and styles from the
// editor's unsaved draft and the store's Appearance settings (§7), as a
// desktop popup or a phone's bottom sheet. Each draws in its own frame at a
// real screen's width, scaled to fit, so the guide's phone styles and the
// merchant's CSS apply there and nowhere else in the admin. Like the
// Appearance and Fit finder previews, it isn't interactive.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { type Guide, parseGuide, render } from "../../lib/guide";
import { css, tableCss } from "../../lib/guide-css";
import { type Draft, cellProblem, parseCell } from "../chart-table/model";
import type { Plan } from "../../models/billing.server";
import type { Settings } from "../../models/settings.server";

/** What the preview draws with besides the draft, from the editor's loader. */
export type Look = {
  settings: Settings;
  primaryLocale: string;
  plan: Plan;
  /** The guide's own words, from the extension's locale file. */
  words: Record<string, string>;
  /** How many products show the chart; none for a new chart. */
  products?: { count: number; atLeast: boolean };
};

/**
 * The guide for draft `d` as the storefront's snippet prints it
 * (extensions/size-guide/snippets/guide-data.liquid), checked by the same
 * parseGuide. `stale` while a cell fails the checks, whose value is left out.
 * "empty" before the chart has a size.
 */
export function previewGuide(d: Draft, look: Look, image?: string) {
  let stale = false;
  const tables = d.content.tables
    .filter((t) => t.rows.length)
    .map((t) => ({
      ...t,
      rows: t.rows.map((r) => {
        const cells: Record<string, number[]> = {};
        for (const c of t.columns) {
          if (c.kind !== "measure") continue;
          const text = d.cells[`${r.id}.${c.id}`] ?? "";
          const cell = parseCell(text);
          if (cellProblem(text)) stale = true;
          else if (Array.isArray(cell)) cells[c.id] = cell;
        }
        return { id: r.id, cells };
      }),
    }));
  if (!tables.length) return "empty" as const;
  const { settings: s, primaryLocale, plan } = look;
  // Only what the snippet prints: no video link, and the fit finder on Pro.
  const { fit, ...content } = d.content;
  delete content.videoUrl;
  const guide = parseGuide(
    JSON.stringify({
      chart: { ...content, tables, ...(plan === "pro" && { fit }) },
      measureImage: image,
      units: s.units,
      link: s.link,
      popup: s.popup,
      placement: s.placement,
      colors: s.colors,
      css: s.css,
      text: s.text[primaryLocale],
      locale: primaryLocale,
      plan,
      fitFinder: s.fitFinder,
    }),
  );
  // The storefront picks in or cm by the shopper's country; here, the chart's own.
  if (guide && s.units.default === "country") guide.sys = d.content.unit;
  return { guide, stale };
}

const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
// The popup as extensions/size-guide/snippets/guide.liquid prints it, with no
// words in it: they're set as text once it loads.
const PAGE = `<!doctype html><html><head><style></style></head><body><div class="fitted-guide"><div class="fitted-dialog"><div class="fitted-panel"><div class="fitted-head"><div><h2 class="fitted-title"></h2><p class="fitted-sub"></p></div><button type="button" class="fitted-x"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div><div class="fitted-body"></div></div></div></div></body></html>`;
// The screens each frame stands for, in CSS px; a desktop's height follows the popup.
const SCREEN = { desktop: { w: 720, h: 0 }, phone: { w: 390, h: 700 } };
type Size = keyof typeof SCREEN;

function Frame(props: {
  guide: Guide;
  words: Record<string, string>;
  name: string;
  tab: string;
  size: Size;
}) {
  const { guide, words, name, tab, size } = props;
  const box = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const page = useRef<HTMLIFrameElement>(null);
  // A frame the server rendered can load before hydration, so before onLoad.
  useEffect(() => {
    const d = page.current?.contentDocument;
    if (d?.querySelector(".fitted-guide")) setDoc(d);
  }, []);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(SCREEN[size].h);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const block = doc?.querySelector<HTMLElement>(".fitted-guide");
    const old = doc?.querySelector(".fitted-body");
    if (!doc || !block || !old) return;
    // Fitted's styles, the uploaded font, then the merchant's CSS, in
    // guide.js's and loader.js's order. A desktop frame grows to fit the
    // popup, so the popup never scrolls there.
    doc.head.querySelector("style")!.textContent =
      `html,body,.fitted-guide{height:100%;margin:0;background:transparent}body{font-family:${FONT}}.fitted-guide{display:flex;flex-direction:column}` +
      tableCss +
      css +
      (SCREEN[size].h ? "" : ".fitted-dialog{max-height:none}") +
      (guide.font
        ? `@font-face{font-family:fitted-font;src:url("${guide.font}");font-display:swap}`
        : "") +
      guide.css;
    block.removeAttribute("style");
    for (const [k, v] of Object.entries(guide.colors ?? {}))
      block.style.setProperty(`--fitted-${k}`, v);
    if (guide.font)
      block.style.setProperty("--fitted-font", `fitted-font,${FONT}`);
    const dialog = block.querySelector<HTMLElement>(".fitted-dialog")!;
    dialog.dir = guide.rtl ? "rtl" : "";
    block.querySelector(".fitted-title")!.textContent =
      guide.header || words.title;
    // Where the storefront names the product, the chart's name.
    const one = guide.tables.length === 1;
    const title = one && guide.words[`${guide.tables[0].id}.title`];
    block.querySelector(".fitted-sub")!.textContent = [name, title]
      .filter(Boolean)
      .join(" · ");
    // A fresh root each time, so no earlier draw's listeners stay on it.
    const root = old.cloneNode(false) as HTMLElement;
    for (const [k, v] of Object.entries(words))
      root.setAttribute(`data-t-${k}`, v);
    old.replaceWith(root);
    doc.body.inert = false;
    render(root, guide);
    // The tab the editor shows, then nothing a shopper could press.
    if (tab === "measure")
      root.querySelector<HTMLElement>('[data-fitted-tab="measure"]')?.click();
    doc.body.inert = true;
    if (SCREEN[size].h) return;
    // The popup's margins, 40px above and below.
    const panel = dialog.querySelector<HTMLElement>(".fitted-panel")!;
    const fit = () => setHeight(panel.offsetHeight + 80);
    fit();
    doc.addEventListener("load", fit, true);
    void doc.fonts?.ready.then(fit);
    return () => doc.removeEventListener("load", fit, true);
  }, [doc, guide, words, name, tab, size]);
  const { w } = SCREEN[size];
  const scale = Math.min(1, width / w);
  return (
    <div ref={box} className="frame" style={{ height: height * scale }}>
      <iframe
        ref={page}
        title="Size guide preview"
        sandbox="allow-same-origin"
        tabIndex={-1}
        srcDoc={PAGE}
        onLoad={(e) => setDoc(e.currentTarget.contentDocument)}
        style={{ width: w, height, transform: `scale(${scale})` }}
      />
    </div>
  );
}

export function ChartPreview(props: {
  draft: Draft;
  look: Look;
  /** The How to measure drawing's address. */
  image?: string;
  /** The editor's tab: How to measure shows the guide's. */
  tab: string;
}) {
  const [size, setSize] = useState<Size>("desktop");
  const { draft, look, image } = props;
  const now = useMemo(
    () => previewGuide(draft, look, image),
    [draft, look, image],
  );
  // The last guide that passed, kept while a cell fails the checks.
  const last = useRef<Guide | null>(null);
  if (now !== "empty" && now.guide && !now.stale) last.current = now.guide;
  const guide = now === "empty" ? null : (last.current ?? now.guide);
  const products = look.products;
  const n = products?.count ?? 0;
  return (
    <aside className="card preview" aria-label="Live preview">
      <div className="row">
        <h2>Live preview</h2>
        {guide && (
          <div role="group" aria-label="Preview size" className="segs">
            {(["desktop", "phone"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={size === s}
                onClick={() => setSize(s)}
              >
                {s === "desktop" ? "Desktop" : "Phone"}
              </button>
            ))}
          </div>
        )}
      </div>
      {now !== "empty" && now.stale && (
        <s-banner tone="warning">
          Showing the last table that passed. Fix the marked cells to update it.
        </s-banner>
      )}
      {now === "empty" ? (
        <p className="stage note">
          Your size guide shows here once the chart has a size.
        </p>
      ) : (
        guide && (
          <div className={`stage ${size}`}>
            <Frame
              key={size}
              guide={guide}
              words={look.words}
              name={draft.name}
              tab={props.tab}
              size={size}
            />
          </div>
        )
      )}
      {now !== "empty" && (
        <div className="row">
          <span className="help">
            {n
              ? `Shown on ${n.toLocaleString("en-US")}${products!.atLeast ? "+" : ""} ${n === 1 && !products!.atLeast ? "product" : "products"}`
              : "Not on any products yet"}
          </span>
          <Link to="/app/rules">Edit display rules</Link>
        </div>
      )}
    </aside>
  );
}
