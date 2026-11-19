// The size guide's first script, assets/loader.js (ARCHITECTURE §9): shows a
// block's Size guide link once its chart validates, and on open shows the
// loading state while assets/guide.js loads, or the error state with Try again.
import { css } from "./guide-css";
import { h, parseGuide, type render } from "./guide";

export type Load = (url: string) => Promise<{ render: typeof render }>;

function setup(block: HTMLElement, load: Load) {
  block.dataset.ready = "";
  const g = parseGuide(block.querySelector("script[data-fitted]")?.textContent);
  const link = block.querySelector<HTMLButtonElement>(".fitted-link");
  const dialog = block.querySelector("dialog");
  const body = dialog?.querySelector<HTMLElement>(".fitted-body");
  if (!g || !link || !dialog?.showModal || !body) return;
  if (!document.getElementById("fitted-css"))
    document.head.append(h("style", { id: "fitted-css" }, css));
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
  const attempt = () => {
    state = "loading";
    if (body.contains(document.activeElement))
      dialog.querySelector<HTMLElement>("[data-fitted-close]")?.focus();
    dialog.setAttribute("aria-busy", "true");
    show("loading");
    // A failed import() stays failed for its URL, so a retry asks for a new one.
    const url = new URL(block.dataset.url ?? "", location.href);
    if (tries) url.searchParams.set("retry", `${tries}`);
    tries++;
    load(url.href)
      .then((guide) => {
        body.replaceChildren();
        guide.render(body, g);
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
    if (state === "idle") attempt();
    dialog.showModal();
  });
  link.style.display = "";
}

/** Sets up every block on the page now, and any the theme or its editor adds later. */
export function start(load: Load) {
  const scan = () =>
    document
      .querySelectorAll<HTMLElement>(".fitted-guide:not([data-ready])")
      .forEach((block) => setup(block, load));
  const go = () => {
    scan();
    new MutationObserver(scan).observe(document.body, {
      childList: true,
      subtree: true,
    });
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", go);
  else go();
}
