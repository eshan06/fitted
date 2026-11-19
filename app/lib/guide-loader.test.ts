// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://shop.example/products/linen-wrap-top"}
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./guide";
import { start, type Load } from "./guide-loader";

// From the repo root: happy-dom's URL can't resolve file: URLs.
const read = (path: string) =>
  readFileSync(`extensions/size-guide/${path}`, "utf8");
const en = JSON.parse(read("locales/en.default.json")).size_guide;
const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The block's Liquid with Shopify's part played by plain substitutions, so
// the loader runs against the markup that ships. `t` escapes, as Shopify's does.
function block(json: string, product = "Linen Wrap Top") {
  let html = read("blocks/size-guide.liquid")
    .replace(/\{%-? comment -?%\}[\s\S]*?\{%-? endcomment -?%\}/g, "")
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

beforeAll(() => start((url) => load(url)));
beforeEach(() => {
  load = vi.fn<Load>(ok);
  guide.render.mockClear();
});

describe("loader", () => {
  it("shows the link once the chart validates, and adds the styles once", async () => {
    const { link } = await mount();
    expect(link.hidden).toBe(false);
    document.body.insertAdjacentHTML("beforeend", block(valid));
    await tick();
    expect(
      document.querySelectorAll(".fitted-link:not([hidden])"),
    ).toHaveLength(2);
    expect(document.querySelectorAll("#fitted-css")).toHaveLength(1);
  });

  it.each([
    ["data that doesn't validate", JSON.stringify({ chart: { v: 2 } })],
    ["data that isn't JSON", "{"],
  ])("leaves the link hidden for %s", async (_, json) => {
    const { link, dialog } = await mount(json);
    expect(link.hidden).toBe(true);
    link.click();
    expect(dialog.open).toBe(false);
    expect(load).not.toHaveBeenCalled();
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
    expect(load).toHaveBeenCalledWith("https://cdn.example/assets/guide.js");
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

  it("names the one table in the subtitle", async () => {
    const { dialog } = await mount();
    expect(dialog.querySelector(".fitted-sub")?.textContent).toBe(
      "Linen Wrap Top · Body measurements",
    );
    expect(dialog.getAttribute("aria-labelledby")).toBe("fitted-title-1");
    expect(dialog.querySelector("#fitted-title-1")?.textContent).toBe(en.title);
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
    const retry = body.querySelector<HTMLButtonElement>("[data-retry]")!;
    retry.focus();
    retry.click();
    // Focus leaves the button being replaced for the close button.
    expect(document.activeElement).toBe(dialog.querySelector(".fitted-x"));
    expect(body.querySelector('[role="status"]')).not.toBeNull();
    // A failed import() is cached for its URL, so the retry's URL differs.
    expect(load).toHaveBeenLastCalledWith(
      "https://cdn.example/assets/guide.js?retry=1",
    );
    await tick();
    expect(body.querySelector("table")).not.toBeNull();
  });

  it("tries again on the next open after a failure", async () => {
    load.mockImplementationOnce(fail);
    const { link, dialog, body } = await mount();
    link.click();
    await tick();
    body.querySelector<HTMLElement>("[data-close]")!.click();
    expect(dialog.open).toBe(false);
    link.click();
    expect(load).toHaveBeenCalledTimes(2);
    await tick();
    expect(body.querySelector("table")).not.toBeNull();
  });

  it("closes from the backdrop but not from a click inside", async () => {
    const { link, dialog, body } = await mount();
    link.click();
    await tick();
    body
      .querySelector("td")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog.open).toBe(true);
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog.open).toBe(false);
  });

  it("sets up blocks the theme adds after the page loaded", async () => {
    document.body.innerHTML = "";
    const section = document.createElement("div");
    section.innerHTML = block(valid, "Rain Jacket");
    document.body.append(section);
    await tick();
    expect(
      section.querySelector<HTMLButtonElement>(".fitted-link")?.hidden,
    ).toBe(false);
  });
});
