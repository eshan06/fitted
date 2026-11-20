// The size guide's first script, assets/loader.js (ARCHITECTURE §9): shows a
// block's Size guide link once its chart validates and the placement settings
// (§7) want it where it sits, and on open shows the loading state while
// assets/guide.js loads, or the error state with Try again. Each later open
// has the guide pick the size the product form shows. It applies the
// Appearance settings (§7) to the link and the popup.
import { css } from "./guide-css";
import { parseGuide, type Guide, type render } from "./guide";

export type Load = (url: string) => Promise<{ render: typeof render }>;

// The canvas's accent. "Match my theme" keeps it where it reads 4.5:1 on the
// theme's background and on its tint, and takes the theme's text color elsewhere.
const ACCENT = "#2448a8";
const WHITE = "rgb(255, 255, 255)";
const BLACK = "rgb(18, 18, 18)";
// WCAG relative luminance of an rgb() or rgba() color (its alpha aside), and
// -1 for any other syntax.
const luminance = (c: string) => {
  const rgb = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)/.exec(c)?.slice(1);
  if (!rgb) return -1;
  const [r, g, b] = rgb.map((n) => {
    const s = +n / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
// The theme's text color where the block sits, and the nearest opaque
// background behind it (rgba() and "/ a" carry an alpha below 1). A section
// painted with a gradient has no background color, so the text can come from
// one look and the background from another: if they don't read 4.5:1, the
// text becomes near-black or white, whichever reads on that background.
function themeColors(block: HTMLElement) {
  let bg = WHITE;
  for (let el: Element | null = block; el; el = el.parentElement) {
    const c = getComputedStyle(el).backgroundColor;
    if (c && !/rgba|\/|transparent/.test(c)) {
      bg = c;
      break;
    }
  }
  let text = getComputedStyle(block).color;
  const [ink, paper] = [luminance(text), luminance(bg)];
  if (ink >= 0 && paper >= 0 && ratio(ink, paper) < 4.5)
    text = ratio(paper, luminance(BLACK)) > ratio(paper, 1) ? BLACK : WHITE;
  return { text, accent: paper >= 0.65 ? ACCENT : text, bg };
}
// Fitted's styles, the uploaded font, then the merchant's CSS as written, so
// it wins ties with Fitted's rules.
const styles = (g: Guide) =>
  Object.assign(document.createElement("style"), {
    id: "fitted-css",
    textContent:
      css +
      (g.font
        ? `@font-face{font-family:fitted-font;src:url("${g.font}");font-display:swap}`
        : "") +
      g.css,
  });

// The app embed's links after a selector, tried again on every change.
const placed: (() => void)[] = [];
// Puts the app embed's link after the first element the merchant's selector
// matches; false when none does, or this browser can't read the selector.
const putAfter = (block: HTMLElement, selector: string) => {
  try {
    const el = document.querySelector(selector);
    el?.after(block);
    return !!el;
  } catch {
    return false;
  }
};

function setup(block: HTMLElement, load: Load) {
  block.dataset.ready = "";
  const g = parseGuide(block.querySelector("script[data-fitted]")?.textContent);
  const link = block.querySelector<HTMLButtonElement>(".fitted-link");
  const dialog = block.querySelector("dialog");
  const body = dialog?.querySelector<HTMLElement>(".fitted-body");
  if (!g || !link || !dialog?.showModal || !body?.replaceChildren) return;
  // Where the block sits (the snippet's place): its product page, or a theme's
  // quick view of it (a popup around it); a featured product section; the
  // embed's tab, or its link after a selector. The embed prints those only
  // when they're on, and hides the app block's link on its page (data-page)
  // while its tab, as the link's style, or its placed link stands in.
  const place = block.dataset.place;
  const popup = block.parentElement?.closest("dialog,[role=dialog]");
  const shown =
    place === "main"
      ? popup
        ? g.quick
        : g.page
      : place !== "featured" || g.featured;
  if (!shown) return;
  if (place === "main" && !popup) block.dataset.page = "";
  const reveal = () => {
    if (!document.getElementById("fitted-css")) document.head.append(styles(g));
    link.style.display = "";
  };
  // The merchant's words and icon, else the extension's word and the ruler.
  const words = link.querySelector("span");
  if (words && g.label) words.textContent = g.label;
  if (g.icon === "none") link.querySelector("svg")?.remove();
  const heading = dialog.querySelector(".fitted-title");
  if (heading && g.header) heading.textContent = g.header;
  if (g.rtl) dialog.dir = "rtl";
  // Colors and the font, read again on each open, as a theme can change them.
  const paint = () => {
    for (const [k, v] of Object.entries(g.colors ?? themeColors(block)))
      block.style.setProperty(`--fitted-${k}`, v);
    if (!g.font) return;
    // The theme's font stands in while the upload loads, or if it can't.
    const theme = getComputedStyle(block).fontFamily;
    const family = theme ? `fitted-font,${theme}` : "fitted-font";
    block.style.setProperty("--fitted-font", family);
  };
  const title = g.tables.length === 1 && g.words[`${g.tables[0].id}.title`];
  if (title) dialog.querySelector(".fitted-sub")?.append(` · ${title}`);
  const show = (state: string) =>
    body.replaceChildren(
      dialog
        .querySelector<HTMLTemplateElement>(`template[data-state="${state}"]`)
        ?.content.cloneNode(true) ?? "",
    );

  // idle: not loaded yet, or the last try failed, so the next open tries again.
  let state: "idle" | "loading" | "ready" = "idle";
  let tries = 0;
  let sync = () => {}; // once drawn, picks the size the product form shows
  const attempt = () => {
    state = "loading";
    if (body.contains(document.activeElement))
      dialog.querySelector<HTMLElement>("[data-fitted-close]")?.focus();
    dialog.setAttribute("aria-busy", "true");
    show("loading");
    // A failed import() stays failed for its URL, so each try asks for its own.
    const url = new URL(block.dataset.url ?? "", location.href);
    url.searchParams.set("try", `${++tries}`);
    load(url.href)
      .then((guide) => {
        body.replaceChildren();
        sync = guide.render(body, g);
        state = "ready";
      })
      .catch(() => {
        show("error");
        state = "idle";
      })
      .finally(() => dialog.removeAttribute("aria-busy"));
  };
  // The backdrop closes the guide only when the press starts there: not a
  // drag out of the table, nor a double click's second click on the link.
  let fromBackdrop = false;
  dialog.addEventListener("pointerdown", (e) => {
    fromBackdrop = e.target === dialog;
  });
  dialog.addEventListener("click", (e) => {
    const el = e.target as Element;
    const backdrop = el === dialog && fromBackdrop && e.detail < 2;
    if (backdrop || el.closest("[data-fitted-close]")) dialog.close();
    else if (el.closest("[data-fitted-retry]")) attempt();
  });
  link.addEventListener("click", () => {
    paint();
    if (state === "idle") attempt();
    else if (state === "ready") sync();
    dialog.showModal();
  });
  if (place !== "after") return reveal();
  // The link after the merchant's selector waits for that element, which a
  // script may draw later, and goes back after it whenever the theme redraws
  // it, with its title's id, which some themes rename as they redraw.
  const id = heading?.id ?? "";
  const put = () => {
    if (block.dataset.placed != null && block.isConnected) return;
    if (!putAfter(block, g.selector)) return;
    block.dataset.placed = "";
    if (heading) heading.id = id;
    reveal();
  };
  put();
  placed.push(put);
}

/**
 * Sets up every block on the page now, and any the theme or its editor adds
 * later, and places the embed's links after a selector once their element
 * is there, and again after a theme redraws it.
 */
export function start(load: Load) {
  const scan = () => {
    placed.forEach((put) => put());
    document
      .querySelectorAll<HTMLElement>(".fitted-guide:not([data-ready])")
      .forEach((block) => setup(block, load));
  };
  // Escape closes the open guide on its key up, wherever focus is, and
  // neither key goes further, so a theme's quick view under the guide stays
  // open whichever key it closes on.
  for (const type of ["keydown", "keyup"])
    addEventListener(
      type,
      (e) => {
        const open = document.querySelector<HTMLDialogElement>(
          ".fitted-dialog[open]",
        );
        if ((e as KeyboardEvent).key !== "Escape" || !open) return;
        e.preventDefault();
        e.stopPropagation();
        if (type === "keyup") open.close();
      },
      true,
    );
  const go = () => {
    scan();
    const changes = { childList: true, subtree: true };
    new MutationObserver(scan).observe(document.body, changes);
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", go);
  else go();
}
