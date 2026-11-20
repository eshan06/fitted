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

// The guide snippet's Liquid with Shopify's part played by plain
// substitutions, so the loader runs against the markup that ships. `t`
// escapes, as Shopify's does. contact is the store's Contact page, or null
// when it has none; place is where the block or embed put it.
function block(
  json: string,
  product = "Linen Wrap Top",
  contact: { url: string; title: string } | null = {
    url: "/pages/contact",
    title: "Contact",
  },
  place: "main" | "featured" | "tab" | "after" = "main",
) {
  let html = read("snippets/guide.liquid")
    .replace(/\{%-? comment -?%\}[\s\S]*?\{%-? endcomment -?%\}/g, "")
    .replace(
      /\{%-? if pages\.contact\.url -?%\}([\s\S]*?)\{%-? endif -?%\}/,
      (_, inner: string) => (contact ? inner : ""),
    )
    .replace(
      /\{%-? if place == 'tab' -?%\}([\s\S]*?)\{%-? endif -?%\}/g,
      (_, inner: string) => (place === "tab" ? inner : ""),
    )
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
      if (expr === "place") return place;
      if (expr === "chart.system.id | escape") return "1301";
      if (expr === "p.id | escape") return "8812";
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
// The guide's events (§12); happy-dom's own would fetch.
const beacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
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
  beacon.mockClear();
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

  it("tells Fitted about each open, naming only the chart and product (§12)", async () => {
    const { link, dialog } = await mount();
    link.click();
    expect(beacon).not.toHaveBeenCalled(); // still loading: no guide yet
    await tick();
    dialog.close();
    link.click();

    const sent = beacon.mock.calls.map(([url, body]) => {
      expect(url).toBe("/apps/fitted/events");
      return JSON.parse(body as string);
    });
    const open = {
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      type: "open",
      chart: "gid://shopify/Metaobject/1301",
      product: "gid://shopify/Product/8812",
    };
    expect(sent).toEqual([open, open]);
    expect(sent[0].id).not.toBe(sent[1].id);
  });

  it("still opens in a browser without sendBeacon, sending nothing", async () => {
    beacon.mockImplementationOnce(() => {
      throw new TypeError("navigator.sendBeacon is not a function");
    });
    const { link, body } = await mount();
    link.click();
    await tick();
    expect(body.querySelector("table")).not.toBeNull();
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
    expect(link.querySelector("span")?.textContent).toBe("Fit <b>guide</b>");
    expect(link.querySelector("svg, b")).toBeNull();
    expect(dialog.querySelector(".fitted-title")?.textContent).toBe(
      "Find your fit",
    );
    expect(dialog.getAttribute("aria-labelledby")).toBe("fitted-title-1");
  });

  it("keeps the extension's word, the ruler and the reading direction without settings", async () => {
    const { link, dialog } = await mount();
    expect(link.querySelector("span")?.textContent).toBe(en.title);
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
      "makes light text near-black over a gradient section on a white page",
      "background-color: rgb(255, 255, 255)",
      { text: "rgb(18, 18, 18)", accent: "#2448a8", bg: "rgb(255, 255, 255)" },
      "background-image: linear-gradient(#123, #456); color: rgba(240, 240, 240, 0.75)",
    ],
    [
      "makes dark text white over a gradient section on a dark page",
      "background-color: rgb(30, 30, 30)",
      {
        text: "rgb(255, 255, 255)",
        accent: "rgb(255, 255, 255)",
        bg: "rgb(30, 30, 30)",
      },
      "background-image: linear-gradient(#eee, #fff); color: rgb(20, 20, 20)",
    ],
    [
      // Browsers give oklch() or color() backgrounds as written; happy-dom
      // gives every color as written, so a hex stands in for them here.
      "keeps a background it can't measure, with the text color as the accent",
      "background-color: #fffaf0; color: rgb(18, 18, 18)",
      { text: "rgb(18, 18, 18)", accent: "rgb(18, 18, 18)", bg: "#fffaf0" },
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

// ARCHITECTURE §7 placement: where each block's link may show.
describe("placement", () => {
  const contact = { url: "/pages/contact", title: "Contact" };
  const placed = (placement: object, link = {}) =>
    withSettings({
      placement,
      link: { style: "text", icon: "ruler", ...link },
    });
  // A size control and product form for the guide's Select, as a theme's.
  const form = (size: string, cls = "size") =>
    `<fieldset class="${cls}"><input type="radio" name="Size" value="${size}" checked></fieldset><form action="/cart/add"></form>`;
  const rows = [
    { id: "m", cells: {} },
    { id: "l", cells: {} },
  ];
  const sized = (settings: Record<string, unknown>) =>
    JSON.stringify({
      ...JSON.parse(withSettings(settings)),
      chart: {
        ...chart,
        tables: [{ ...chart.tables[0], rows }],
        words: { "t1.m.size": "M", "t1.l.size": "L" },
      },
    });
  const open = async (link: HTMLElement) => {
    link.click();
    await tick();
    return link.closest(".fitted-guide")!.querySelector(".fitted-foot strong")
      ?.textContent;
  };

  it.each([
    ["by default", {}, true],
    ["but not with that placement off", { productBlock: false }, false],
  ])(
    "shows the app block's link on its product page %s",
    async (_, placement, on) => {
      const { root, link } = await mount(placed(placement));
      expect(shown(link)).toBe(on);
      expect(root.hasAttribute("data-page")).toBe(on);
    },
  );

  it.each([
    ['<div role="dialog" aria-modal="true">', "</div>"],
    ["<dialog open>", "</dialog>"],
  ])(
    "shows it in a theme's quick view (%s) only with that placement on",
    async (start, end) => {
      document.body.innerHTML = `${start}${block(placed({}))}${end}`;
      await tick();
      expect(shown(document.querySelector<HTMLElement>(".fitted-link")!)).toBe(
        false,
      );
      document.body.innerHTML = `${start}${block(placed({ quickView: true }))}${end}`;
      await tick();
      const guide = document.querySelector<HTMLElement>(".fitted-guide")!;
      expect(shown(guide.querySelector(".fitted-link")!)).toBe(true);
      // Not its product page, so the embed's styles never hide it.
      expect(guide.hasAttribute("data-page")).toBe(false);
    },
  );

  // The embed's styles (blocks/embed.liquid), as it prints them.
  const [tabStyle, afterStyle] = read("blocks/embed.liquid").match(
    /<style>[\s\S]*?<\/style>/g,
  )!;
  const display = (el: Element) => getComputedStyle(el).display;

  it("lets the tab, as the link's style, stand in for the app block's link on its page, not in a quick view", async () => {
    const settings = placed({ quickView: true }, { style: "tab" });
    document.body.innerHTML = `${tabStyle}${block(settings)}<div role="dialog">${block(settings)}</div>`;
    await tick();
    const [page, quick] = document.querySelectorAll(".fitted-link");
    expect([display(page), display(quick)]).toEqual(["none", "inline-flex"]);
  });

  it("lets the placed selector link stand in for the app block's link, and only once placed", async () => {
    const json = placed({ selector: ".late" });
    document.body.innerHTML = `${afterStyle}${block(json)}${block(json, "Linen Wrap Top", contact, "after")}`;
    await tick();
    const [page, after] =
      document.querySelectorAll<HTMLElement>(".fitted-link");
    // Nothing matches yet: the app block's link stays.
    expect([shown(after), display(page)]).toEqual([false, "inline-flex"]);
    // A script draws the element later; the link goes after it.
    document.body.insertAdjacentHTML("afterbegin", '<div class="late"></div>');
    await tick();
    expect(document.querySelector(".late")?.nextElementSibling).toBe(
      after.closest(".fitted-guide"),
    );
    expect([shown(after), display(page)]).toEqual([true, "none"]);
  });

  it("has Select pick the size in the quick view's own product form", async () => {
    const json = sized({ placement: { quickView: true } });
    document.body.innerHTML = `<div class="shopify-section">${form("L")}</div><div role="dialog">${form("M")}${block(json)}</div>`;
    await tick();
    expect(
      await open(document.querySelector<HTMLElement>(".fitted-link")!),
    ).toBe("Selected: M");
  });

  it.each([
    [{}, false],
    [{ featured: true }, true],
  ])(
    "shows a featured product section's link with %o",
    async (placement, on) => {
      document.body.innerHTML = block(
        placed(placement),
        "Rain Jacket",
        contact,
        "featured",
      );
      await tick();
      expect(shown(document.querySelector<HTMLElement>(".fitted-link")!)).toBe(
        on,
      );
    },
  );

  it("shows the embed's floating tab with the link's words and icon setting", async () => {
    document.body.innerHTML = block(
      withSettings({
        placement: { floatingTab: true },
        link: { style: "text", icon: "none" },
        text: { label: "Fit guide" },
      }),
      "Linen Wrap Top",
      contact,
      "tab",
    );
    await tick();
    const tab = document.querySelector<HTMLElement>(".fitted-link")!;
    expect(shown(tab)).toBe(true);
    expect(tab.classList).toContain("fitted-tab");
    expect(tab.querySelector("span")?.textContent).toBe("Fit guide");
    expect(tab.querySelector("svg")).toBeNull();
    expect(
      document.querySelector(".fitted-guide style")?.textContent,
    ).toContain(".fitted-tab{position:fixed;");
  });

  it("has the tab's Select pick the size in the page's product form", async () => {
    const json = sized({ placement: { floatingTab: true } });
    document.body.innerHTML = `<div class="shopify-section">${form("M")}</div><div>${block(json, "Linen Wrap Top", contact, "tab")}</div>`;
    await tick();
    expect(
      await open(document.querySelector<HTMLElement>(".fitted-link")!),
    ).toBe("Selected: M");
  });

  // Its own class, as the loader keeps putting this link back after .picker.
  it("puts the embed's link after the selector's element, and back after the theme redraws it", async () => {
    const json = sized({ placement: { selector: ".picker" } });
    document.body.innerHTML = `<div class="shopify-section">${form("M", "picker")}</div>${block(json, "Linen Wrap Top", contact, "after")}`;
    await tick();
    const guide = document.querySelector<HTMLElement>(".fitted-guide")!;
    expect(guide.previousElementSibling).toBe(
      document.querySelector(".picker"),
    );
    expect(shown(guide.querySelector(".fitted-link")!)).toBe(true);
    expect(await open(guide.querySelector<HTMLElement>(".fitted-link")!)).toBe(
      "Selected: M",
    );
    guide.querySelector("dialog")!.close();
    // The theme redraws its size picker, taking the link with it, and renames
    // the ids in what it drops first, as Dawn's does.
    const section = document.querySelector(".shopify-section")!;
    section.querySelectorAll("[id]").forEach((el) => (el.id += "-1700000000"));
    section.innerHTML = form("L", "picker");
    await tick();
    expect(guide.isConnected).toBe(true);
    expect(guide.previousElementSibling).toBe(
      document.querySelector(".picker"),
    );
    const dialog = guide.querySelector("dialog")!;
    expect(
      guide.querySelector(`#${dialog.getAttribute("aria-labelledby")}`),
    ).not.toBeNull();
  });

  it.each([
    ["matches nothing", ".nothing"],
    ["this browser can't read", "a["],
  ])(
    "leaves the embed's link hidden when its selector %s",
    async (_, selector) => {
      document.body.innerHTML = `<div class="size"></div>${block(placed({ selector }), "Linen Wrap Top", contact, "after")}`;
      await tick();
      const guide = document.querySelector<HTMLElement>(".fitted-guide")!;
      expect(shown(guide.querySelector(".fitted-link")!)).toBe(false);
      expect(guide.parentElement).toBe(document.body);
    },
  );

  it("closes on Escape, wherever focus is, without the key reaching a theme's quick view underneath", async () => {
    document.body.innerHTML = `<div role="dialog">${block(placed({ quickView: true }))}</div>`;
    await tick();
    const theme = vi.fn();
    const quick = document.querySelector('[role="dialog"]')!;
    for (const type of ["keydown", "keyup"]) {
      quick.addEventListener(type, theme);
      document.addEventListener(type, theme);
    }
    const link = document.querySelector<HTMLElement>(".fitted-link")!;
    const dialog = document.querySelector("dialog")!;
    const key = (on: Element, type: string, k = "Escape") => {
      const e = new KeyboardEvent(type, {
        key: k,
        bubbles: true,
        cancelable: true,
      });
      on.dispatchEvent(e);
      return e;
    };
    // Focus in the guide, or on the page after a press on a table cell.
    for (const on of [dialog.querySelector(".fitted-x")!, document.body]) {
      link.click();
      await tick();
      theme.mockClear();
      key(on, "keydown", "Tab");
      expect(theme).toHaveBeenCalled(); // other keys go on as usual
      theme.mockClear();
      expect(key(on, "keydown").defaultPrevented).toBe(true);
      expect(dialog.open).toBe(true);
      key(on, "keyup");
      expect(dialog.open).toBe(false);
      expect(theme).not.toHaveBeenCalled();
    }
    // With the guide closed, Escape is the theme's again.
    expect(key(document.body, "keyup").defaultPrevented).toBe(false);
    expect(theme).toHaveBeenCalled();
    for (const type of ["keydown", "keyup"])
      document.removeEventListener(type, theme);
  });
});
