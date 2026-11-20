// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://shop.example/products/linen-wrap-top"}
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./guide";
import { css } from "./guide-css";
import { start, type Load } from "./guide-loader";

// From the repo root: happy-dom's URL can't resolve file: URLs.
const read = (path: string) =>
  readFileSync(`extensions/size-guide/${path}`, "utf8");
const en = JSON.parse(read("locales/en.default.json")).size_guide;
const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The block's Liquid with Shopify's part played by plain substitutions, so
// the loader runs against the markup that ships. `t` escapes, as Shopify's
// does. contact is the store's Contact page, or null when it has none.
function block(
  json: string,
  product = "Linen Wrap Top",
  contact: { url: string; title: string } | null = {
    url: "/pages/contact",
    title: "Contact",
  },
) {
  let html = read("blocks/size-guide.liquid")
    .replace(/\{%-? comment -?%\}[\s\S]*?\{%-? endcomment -?%\}/g, "")
    .replace(
      /\{%-? if pages\.contact\.url -?%\}([\s\S]*?)\{%-? endif -?%\}/,
      (_, inner: string) => (contact ? inner : ""),
    )
    .replace(/\{% schema %\}[\s\S]*?\{% endschema %\}/, "")
    .replace(
      /\{%-? render 'guide-data'.*?%\}/,
      () => `<script type="application/json" data-fitted>${json}</script>`,
    );
  const loop =
    /\{%-? for \w+ in \((\d+)\.\.(\d+)\) -?%\}((?:(?!\{%-? for )[\s\S])*?)\{%-? endfor -?%\}/;
  for (let m; (m = loop.exec(html));)
    html = html.replace(m[0], m[3].repeat(Number(m[2]) - Number(m[1]) + 1));
  return html
    .replace(/\{%[\s\S]*?%\}/g, "")
    .replace(/\{\{-? (.*?) -?\}\}/g, (_, expr: string) => {
      const key = /^'size_guide\.(\w+)' \| t$/.exec(expr)?.[1];
      if (key) return escape(en[key]);
      if (expr === "'guide.js' | asset_url")
        return "//cdn.example/assets/guide.js";
      if (expr === "p.title | escape") return escape(product);
      if (expr === "pages.contact.url | escape") return escape(contact!.url);
      if (expr === "pages.contact.title | escape")
        return escape(contact!.title);
      if (expr === "title_id") return "fitted-title-1";
      throw new Error(`No test value for {{ ${expr} }}`);
    });
}

const chart = {
  v: 1,
  unit: "in",
  roundTo: 0.5,
  tables: [
    {
      id: "t1",
      columns: [
        { id: "size", kind: "size" },
        { id: "bust", kind: "measure", convert: true },
      ],
      rows: [{ id: "m", cells: { bust: [35, 36] } }],
    },
  ],
  words: { "t1.title": "Body measurements", "t1.m.size": "M" },
};
const valid = JSON.stringify({
  chart,
  strings: {},
  country: "US",
  locale: "en",
});
// The data snippet's output with Appearance settings in it (§7).
const withSettings = (settings: Record<string, unknown>) =>
  JSON.stringify({ ...JSON.parse(valid), ...settings });
const painted = (block: HTMLElement) =>
  Object.fromEntries(
    ["text", "accent", "bg"].map((k) => [
      k,
      block.style.getPropertyValue(`--fitted-${k}`),
    ]),
  );

let load: ReturnType<typeof vi.fn<Load>>;
const guide = { render: vi.fn(render) };
const ok = () => Promise.resolve(guide);
const fail = () => Promise.reject(new TypeError("Failed to fetch module"));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function mount(json = valid) {
  document.body.innerHTML = block(json);
  await tick();
  const root = document.querySelector<HTMLElement>(".fitted-guide")!;
  return {
    root,
    link: root.querySelector<HTMLButtonElement>(".fitted-link")!,
    dialog: root.querySelector("dialog")!,
    body: root.querySelector<HTMLElement>(".fitted-body")!,
  };
}
// The link is hidden by an inline !important style, which no theme rule beats.
const shown = (link: HTMLElement) => link.style.display !== "none";
const press = (down: Element, up: Element, detail = 1) => {
  down.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  up.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
};

beforeAll(() => start((url) => load(url)));
beforeEach(() => {
  load = vi.fn<Load>(ok);
  guide.render.mockClear();
});

// Each assertion here runs before the earlier start()'s observer can act.
describe("start", () => {
  const link = () => document.querySelector<HTMLElement>(".fitted-link")!;

  it("sets up the blocks already on the page", () => {
    document.body.innerHTML = block(valid);
    start((url) => load(url));
    expect(shown(link())).toBe(true);
  });

  it("waits for the page to finish parsing when it runs early", () => {
    const parsing = vi
      .spyOn(document, "readyState", "get")
      .mockReturnValue("loading");
    document.body.innerHTML = block(valid);
    start((url) => load(url));
    expect(shown(link())).toBe(false);
    parsing.mockRestore();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(shown(link())).toBe(true);
  });
});

describe("loader", () => {
  it("shows the link once the chart validates, and adds the styles once", async () => {
    const { link } = await mount();
    expect(shown(link)).toBe(true);
    document.body.insertAdjacentHTML("beforeend", block(valid));
    await tick();
    const links = document.querySelectorAll<HTMLElement>(".fitted-link");
    expect([...links].filter(shown)).toHaveLength(2);
    expect(document.querySelectorAll("#fitted-css")).toHaveLength(1);
  });

  it.each([
    ["data that doesn't validate", JSON.stringify({ chart: { v: 2 } })],
    ["data that isn't JSON", "{"],
  ])("leaves the link hidden for %s", async (_, json) => {
    const { link, dialog } = await mount(json);
    expect(shown(link)).toBe(false);
    link.click();
    expect(dialog.open).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("leaves the link hidden in a browser without <dialog>", async () => {
    const proto = HTMLDialogElement.prototype;
    const showModal = proto.showModal;
    Reflect.deleteProperty(proto, "showModal");
    try {
      const { link } = await mount();
      expect(shown(link)).toBe(false);
    } finally {
      proto.showModal = showModal;
    }
  });

  it("opens on the loading state, then draws the chart", async () => {
    let finish!: () => void;
    load.mockImplementation(
      () => new Promise((r) => (finish = () => r(guide))),
    );
    const { link, dialog, body } = await mount();
    link.click();
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    expect(body.querySelector('[role="status"]')?.textContent).toBe(en.loading);
    expect(body.querySelectorAll(".fitted-skrow")).toHaveLength(6);
    expect(load).toHaveBeenCalledWith(
      "https://cdn.example/assets/guide.js?try=1",
    );
    finish();
    await tick();
    expect(dialog.hasAttribute("aria-busy")).toBe(false);
    expect(guide.render).toHaveBeenCalledWith(
      body,
      expect.objectContaining({ sys: "in" }),
    );
    expect(body.querySelector("tbody td")?.textContent).toBe("35–36");
    expect(body.querySelector('[role="status"]')).toBeNull();
  });

  it("hands the guide the extension's words", async () => {
    const { body } = await mount();
    const words = ["chart", "system", "units", "in", "cm", "lb", "kg"];
    for (const k of [...words, "choose", "selected", "select"])
      expect(body.dataset[`t${k[0].toUpperCase()}${k.slice(1)}`]).toBe(en[k]);
  });

  it("names the one table in the subtitle", async () => {
    const { dialog } = await mount();
    expect(dialog.querySelector(".fitted-sub")?.textContent).toBe(
      "Linen Wrap Top · Body measurements",
    );
    expect(dialog.getAttribute("aria-labelledby")).toBe("fitted-title-1");
    expect(dialog.querySelector("#fitted-title-1")?.textContent).toBe(en.title);
  });

  it("keeps the subtitle to the product when there are several tables", async () => {
    const tables = [chart.tables[0], { ...chart.tables[0], id: "t2" }];
    const { dialog } = await mount(
      JSON.stringify({ chart: { ...chart, tables }, country: "US" }),
    );
    expect(dialog.querySelector(".fitted-sub")?.textContent).toBe(
      "Linen Wrap Top",
    );
  });

  it("loads once: closing and opening again keeps the chart", async () => {
    const { link, dialog, body } = await mount();
    link.click();
    await tick();
    dialog.querySelector<HTMLElement>(".fitted-x")!.click();
    expect(dialog.open).toBe(false);
    link.click();
    expect(dialog.open).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(body.querySelector("table")).not.toBeNull();
  });

  it("shows the error state when guide.js fails, and Try again asks anew", async () => {
    load.mockImplementationOnce(fail);
    const { link, dialog, body } = await mount();
    link.click();
    await tick();
    const alert = body.querySelector('[role="alert"]');
    expect(alert?.querySelector("h3")?.textContent).toBe(en.error);
    expect(alert?.textContent).toContain(en.error_text);
    expect(dialog.hasAttribute("aria-busy")).toBe(false);
    const retry = body.querySelector<HTMLButtonElement>("[data-fitted-retry]")!;
    retry.focus();
    retry.click();
    // Focus leaves the button being replaced for the close button.
    expect(document.activeElement).toBe(dialog.querySelector(".fitted-x"));
    expect(body.querySelector('[role="status"]')).not.toBeNull();
    // A failed import() is cached for its URL, so the retry's URL differs.
    expect(load).toHaveBeenLastCalledWith(
      "https://cdn.example/assets/guide.js?try=2",
    );
    await tick();
    expect(body.querySelector("table")).not.toBeNull();
  });

  it("links the store's Contact page under the error, when it has one", async () => {
    load.mockImplementation(fail);
    const { link, body } = await mount();
    link.click();
    await tick();
    const help = body.querySelector('[role="alert"] .fitted-help');
    expect(help?.textContent).toBe(`${en.help} Contact.`);
    expect(help?.querySelector("a")?.getAttribute("href")).toBe(
      "/pages/contact",
    );
    document.body.innerHTML = block(valid, "Linen Wrap Top", null);
    await tick();
    document.querySelector<HTMLElement>(".fitted-link")!.click();
    await tick();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelector(".fitted-help")).toBeNull();
  });

  it("opens on the size the product form shows, every time", async () => {
    const rows = [
      { id: "m", cells: {} },
      { id: "l", cells: {} },
    ];
    const json = JSON.stringify({
      chart: {
        ...chart,
        tables: [{ ...chart.tables[0], rows }],
        words: { "t1.m.size": "M", "t1.l.size": "L" },
      },
      country: "US",
    });
    document.body.innerHTML = `<div class="shopify-section"><input type="radio" name="Size" value="M" checked><input type="radio" name="Size" value="L"><form action="/cart/add"></form>${block(json)}</div>`;
    await tick();
    const link = document.querySelector<HTMLElement>(".fitted-link")!;
    const dialog = document.querySelector("dialog")!;
    const selected = () =>
      dialog.querySelector(".fitted-foot strong")?.textContent;
    link.click();
    await tick();
    expect(selected()).toBe("Selected: M");
    dialog.close();
    document.querySelector<HTMLInputElement>('[value="L"]')!.click();
    link.click();
    expect(selected()).toBe("Selected: L");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("tries again on the next open after a failure", async () => {
    load.mockImplementationOnce(fail);
    const { link, dialog, body } = await mount();
    link.click();
    await tick();
    body.querySelector<HTMLElement>("[data-fitted-close]")!.click();
    expect(dialog.open).toBe(false);
    link.click();
    expect(load).toHaveBeenCalledTimes(2);
    await tick();
    expect(body.querySelector("table")).not.toBeNull();
  });

  it("closes on a press on the backdrop, and only then", async () => {
    const { link, dialog, body } = await mount();
    link.click();
    await tick();
    const cell = body.querySelector("td")!;
    press(cell, cell);
    expect(dialog.open).toBe(true);
    // A drag that starts in the table and ends over the backdrop.
    press(cell, dialog);
    expect(dialog.open).toBe(true);
    // A double click's second click, landing on the backdrop the first opened.
    press(dialog, dialog, 2);
    expect(dialog.open).toBe(true);
    press(dialog, dialog);
    expect(dialog.open).toBe(false);
  });

  it("leaves a press inside the guide alone, so text selection and focus work", async () => {
    const { link, body } = await mount();
    link.click();
    await tick();
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    body.querySelector("td")!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
  });

  it("ignores close hooks in the theme's markup around the block", async () => {
    document.body.innerHTML = `<div data-close data-retry>${block(valid)}</div>`;
    await tick();
    const link = document.querySelector<HTMLElement>(".fitted-link")!;
    const dialog = document.querySelector("dialog")!;
    link.click();
    await tick();
    dialog.querySelector("td")!.click();
    expect(dialog.open).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shows the merchant's label, header and icon setting, as text", async () => {
    const { link, dialog } = await mount(
      withSettings({
        text: { label: "Fit <b>guide</b>", header: "Find your fit" },
        link: { style: "text", icon: "none" },
      }),
    );
    expect(link.textContent).toBe("Fit <b>guide</b>");
    expect(link.querySelector("svg, b")).toBeNull();
    expect(dialog.querySelector(".fitted-title")?.textContent).toBe(
      "Find your fit",
    );
    expect(dialog.getAttribute("aria-labelledby")).toBe("fitted-title-1");
  });

  it("keeps the extension's word, the ruler and the reading direction without settings", async () => {
    const { link, dialog } = await mount();
    expect(link.lastChild?.textContent).toBe(en.title);
    expect(link.querySelectorAll("svg")).toHaveLength(1);
    expect(dialog.querySelector(".fitted-title")?.textContent).toBe(en.title);
    expect(dialog.hasAttribute("dir")).toBe(false);
  });

  it("lays the popup out right to left when the setting is on", async () => {
    const { link, dialog } = await mount(
      withSettings({ popup: { rtl: true } }),
    );
    expect(dialog.dir).toBe("rtl");
    expect(link.closest("[dir]")).toBeNull();
  });

  it("paints the merchant's colors on the guide when it opens", async () => {
    const colors = { text: "#202223", accent: "#b3301c", bg: "#fffaf0" };
    const { root, link } = await mount(
      withSettings({
        colors: { ...colors, mode: "custom", background: colors.bg },
      }),
    );
    link.click();
    expect(painted(root)).toEqual(colors);
  });

  it.each([
    [
      "keeps the accent on a light background",
      "background-color: rgb(250, 247, 240); color: rgb(18, 18, 18)",
      { text: "rgb(18, 18, 18)", accent: "#2448a8", bg: "rgb(250, 247, 240)" },
    ],
    [
      "uses the text color for the accent on a dark one",
      "background-color: rgb(18, 18, 18); color: rgb(240, 240, 240)",
      {
        text: "rgb(240, 240, 240)",
        accent: "rgb(240, 240, 240)",
        bg: "rgb(18, 18, 18)",
      },
    ],
    [
      "reads white when nothing opaque is behind the block",
      "background-color: rgba(0, 0, 0, 0.5); color: rgb(18, 18, 18)",
      { text: "rgb(18, 18, 18)", accent: "#2448a8", bg: "rgb(255, 255, 255)" },
    ],
    [
      "puts light text on near-black when the section's background is a gradient over white",
      "background-color: rgb(255, 255, 255)",
      {
        text: "rgba(240, 240, 240, 0.75)",
        accent: "rgba(240, 240, 240, 0.75)",
        bg: "rgb(18, 18, 18)",
      },
      "background-image: linear-gradient(#123, #456); color: rgba(240, 240, 240, 0.75)",
    ],
  ])("matches the theme on open: %s", async (_, theme, colors, inner = "") => {
    document.body.innerHTML = `<div style="${theme}"><div style="${inner}">${block(valid)}</div></div>`;
    await tick();
    const root = document.querySelector<HTMLElement>(".fitted-guide")!;
    root.querySelector<HTMLElement>(".fitted-link")!.click();
    expect(painted(root)).toEqual(colors);
  });

  it("adds the uploaded font and the custom CSS once, after Fitted's styles", async () => {
    document.getElementById("fitted-css")?.remove();
    const font = "https://cdn.shopify.com/s/files/1/0001/font.woff2?v=1";
    // As written: inside @scope (.fitted-guide), a selector naming the guide
    // itself or an ancestor would match nothing.
    const custom = "body .fitted-guide .fitted-link { letter-spacing: .1em }";
    const { root, link } = await mount(
      withSettings({ popup: { font: { fileUrl: font } }, css: custom }),
    );
    document.body.insertAdjacentHTML("beforeend", block(valid));
    await tick();
    const styles = document.querySelectorAll("#fitted-css");
    expect(styles).toHaveLength(1);
    const text = styles[0].textContent!;
    expect(text.startsWith(css)).toBe(true);
    expect(text).toContain(
      `@font-face{font-family:fitted-font;src:url("${font}");font-display:swap}`,
    );
    expect(text.endsWith(custom)).toBe(true);
    expect(text).not.toContain("@scope");
    expect(root.style.getPropertyValue("--fitted-font")).toBe("");
    link.click();
    expect(root.style.getPropertyValue("--fitted-font")).toMatch(
      /^fitted-font\b/,
    );
  });

  it("keeps the canvas's shades where color-mix() isn't supported", () => {
    expect(css).toContain(
      "@supports not (color:color-mix(in srgb,red,red)){.fitted-dialog{--fitted-muted:#3a3a3a;--fitted-line:#d9dde3;--fitted-faint:#e6eaf2;--fitted-tint:#e9eef9;--fitted-alert:#fdeceb;--fitted-alert-line:#e0a9a1}}",
    );
  });

  it("adds no font or CSS from settings that don't validate", async () => {
    document.getElementById("fitted-css")?.remove();
    const { link } = await mount(
      withSettings({
        popup: { font: { fileUrl: "https://evil.example/a.woff2" } },
        css: ".fitted-link { background: url(https://evil.example/t.gif) }",
      }),
    );
    expect(document.getElementById("fitted-css")?.textContent).toBe(css);
    link.click();
    expect(
      link
        .closest<HTMLElement>(".fitted-guide")!
        .style.getPropertyValue("--fitted-font"),
    ).toBe("");
  });

  it("sets up blocks the theme adds after the page loaded", async () => {
    document.body.innerHTML = "";
    const section = document.createElement("div");
    section.innerHTML = block(valid, "Rain Jacket");
    document.body.append(section);
    await tick();
    expect(shown(section.querySelector<HTMLElement>(".fitted-link")!)).toBe(
      true,
    );
  });
});
