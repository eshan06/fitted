// The size guide's first script, assets/loader.js (ARCHITECTURE §9): shows a
// block's Size guide link once its chart validates and the placement settings
// (§7) want it where it sits, and on open shows the loading state while
// assets/guide.js loads, or the error state with Try again. Each later open
// has the guide pick the size the product form shows. It applies the
// Appearance settings (§7) to the link and the popup.
import {
  keyOf,
  parseGuide,
  themeColors,
  type fits,
  type Guide,
  type render,
} from "./guide";

export type Load = (
  url: string,
) => Promise<{ render: typeof render; fits: typeof fits }>;

// Fitted's styles, which each guide's snippet prints inert so this file
// carries none, the uploaded font, then the merchant's CSS as written, so it
// wins ties with Fitted's rules.
const styles = (fitted: HTMLTemplateElement, g: Guide) =>
  Object.assign(document.createElement("style"), {
    id: "fitted-css",
    textContent:
      fitted.content.textContent +
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
  const page = place === "main" && !popup;
  if (page) block.dataset.page = "";
  const colors = (el: HTMLElement, c: Record<string, string>) => {
    for (const [k, v] of Object.entries(c))
      el.style.setProperty(`--fitted-${k}`, v);
  };
  // The styles go in once, from any guide that prints them: markup from
  // before they moved into the snippet has none, so it leaves them to the next.
  // The link keeps the theme's colors, whatever the popup's, for the Button
  // style's hover.
  const reveal = () => {
    const fitted = document.querySelector<HTMLTemplateElement>(
      "template[data-fitted-css]",
    );
    if (fitted && !document.getElementById("fitted-css"))
      document.head.append(styles(fitted, g));
    colors(link, themeColors(block));
    link.style.display = "";
  };
  // The merchant's words, else the extension's.
  const words = link.querySelector("span");
  if (words && g.label) words.textContent = g.label;
  const heading = dialog.querySelector(".fitted-title");
  if (heading && g.header) heading.textContent = g.header;
  if (g.rtl) dialog.dir = "rtl";
  // Colors and the font, read again on each open, as a theme can change them.
  const paint = () => {
    colors(block, g.colors ?? themeColors(block));
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
  // guide.js, loaded once: on the first open, or before it for the fit line.
  // A failed import() stays failed for its URL, so each try asks for its own.
  let guide: ReturnType<Load> | undefined;
  const get = () => {
    if (guide) return guide;
    const url = new URL(block.dataset.url ?? "", location.href);
    url.searchParams.set("try", `${++tries}`);
    return (guide = load(url.href).catch((e) => {
      guide = undefined;
      throw e;
    }));
  };
  const attempt = () => {
    state = "loading";
    if (body.contains(document.activeElement))
      dialog.querySelector<HTMLElement>("[data-fitted-close]")?.focus();
    dialog.setAttribute("aria-busy", "true");
    show("loading");
    get()
      .then((m) => {
        body.replaceChildren();
        sync = m.render(body, g);
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
  // On its product page, answers kept for this chart show what fits them
  // under the link (§10), so guide.js loads now to draw it.
  try {
    if (page && sessionStorage.getItem(keyOf(g)))
      get().then(
        (m) => m.fits(),
        () => {},
      );
  } catch {
    // No storage: no kept answers.
  }
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
