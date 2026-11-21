// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { css, tableCss } from "./guide-css";

// happy-dom's screen and motion setting, which its media queries read.
const dom = (
  window as unknown as {
    happyDOM: {
      setViewport(v: { width: number; height: number }): void;
      settings: { device: { prefersReducedMotion: string } };
    };
  }
).happyDOM;
const SCREENS = {
  laptop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
  // Some zoom levels give a width between whole pixels.
  between: { width: 600.5, height: 800 },
};
afterEach(() => {
  dom.setViewport({ width: 1024, height: 768 });
  dom.settings.device.prefersReducedMotion = "no-preference";
});

// The guide's popup, open, with the snippet's classes and render's parts, on
// a screen, under the styles as a page has them: the tables' first.
function popup(
  classes: string,
  screen: keyof typeof SCREENS = "laptop",
  motion = "no-preference",
) {
  dom.setViewport(SCREENS[screen]);
  dom.settings.device.prefersReducedMotion = motion;
  // The styles go in after the screen is set, so they're read for it.
  document.head.innerHTML = `<style>${tableCss}</style><style>${css}</style>`;
  document.body.innerHTML = `<div class="fitted-guide"><dialog class="fitted-dialog ${classes}" open><div class="fitted-panel"><div class="fitted-head"><div><h2 class="fitted-title">Size guide</h2></div></div><div class="fitted-body"><div class="fitted-scroll"><table class="fitted-table"><thead><tr><th>Size</th></tr></thead></table></div><div class="fitted-foot"></div></div></div></dialog></div>`;
  const dialog = document.querySelector("dialog")!;
  const look = (el: Element, ...keys: string[]) =>
    keys.map((k) => getComputedStyle(el).getPropertyValue(k));
  return {
    dialog,
    look,
    part: (cls: string) => dialog.querySelector(`.${cls}`)!,
    // happy-dom keeps the animation shorthand whole: its name, unless a
    // later rule names another.
    opening: () => {
      const [name, all] = look(dialog, "animation-name", "animation");
      return name || all.split(" ")[0];
    },
  };
}

describe("the popup's style and phone sheet (§7)", () => {
  it("puts the side drawer full height at the right", () => {
    const { dialog, look } = popup("fitted-drawer");
    expect(look(dialog, "width", "height", "margin")).toEqual([
      "480px",
      "100%",
      "0px 0px 0px auto",
    ]);
  });

  it("puts the drawer at the right at any width the phones' rules leave out, fractions of a pixel included", () => {
    const { dialog, look } = popup("fitted-drawer", "between");
    expect(look(dialog, "width", "margin")).toEqual([
      "480px",
      "0px 0px 0px auto",
    ]);
  });

  it("lets a table take the drawer's whole width, which a classic scroll bar cuts below 420px", () => {
    const { part, look } = popup("fitted-drawer");
    expect(look(part("fitted-table"), "min-width")).toEqual(["0"]);
    // As drawn, the drawer's cells keep 8px at their sides.
    expect(
      look(part("fitted-table").querySelector("th")!, "padding-left"),
    ).toEqual(["8px"]);
  });

  it.each(["", "fitted-drawer"])(
    "shows phones the bottom sheet whatever the popup style (%s)",
    (classes) => {
      const { dialog, look } = popup(classes, "phone");
      expect(look(dialog, "width", "margin", "border-radius")).toEqual([
        "100%",
        "auto 0px 0px",
        "14px 14px 0px 0px",
      ]);
    },
  );

  it("shows phones a card with the page round it when the sheet is off", () => {
    const { dialog, look, part } = popup("fitted-nosheet", "phone");
    expect(look(dialog, "width", "height", "margin")).toEqual([
      "calc(100% - 24px)",
      "calc(100% - 84px)",
      "48px auto 36px",
    ]);
    // Its title is 26px, as drawn; the sheet's stays 28px.
    expect(look(part("fitted-title"), "font-size")).toEqual(["26px"]);
    const sheet = popup("", "phone");
    expect(sheet.look(sheet.part("fitted-title"), "font-size")).toEqual([
      "28px",
    ]);
    // The phones' sheet off changes nothing on a laptop.
    const wide = popup("fitted-nosheet");
    expect(wide.look(wide.dialog, "width", "margin")).toEqual([
      "calc(100% - 32px)",
      "40px auto auto",
    ]);
  });

  it("shows phones the drawer leaving a strip of the page when the sheet is off", () => {
    const { dialog, look } = popup("fitted-nosheet fitted-drawer", "phone");
    expect(look(dialog, "width", "height", "margin")).toEqual([
      "calc(100% - 46px)",
      "100%",
      "0px 0px 0px auto",
    ]);
  });

  it.each([
    ["the centered popup", "", "laptop", ["28px", "32px", "0px"]],
    ["the drawer", "fitted-drawer", "laptop", ["24px", "28px", "28px"]],
    ["a phone's sheet", "", "phone", ["18px", "16px", "16px"]],
    ["a phone's card", "fitted-nosheet", "phone", ["16px", "16px", "16px"]],
    [
      "a phone's drawer",
      "fitted-nosheet fitted-drawer",
      "phone",
      ["16px", "16px", "16px"],
    ],
  ] as const)(
    "pads %s as drawn, the footer reaching the sides in the drawer and on phones",
    (_, classes, screen, pads) => {
      const { dialog, look } = popup(classes, screen);
      expect(look(dialog, "--fitted-py", "--fitted-px", "--fitted-fx")).toEqual(
        pads,
      );
    },
  );

  it.each([
    ["the centered popup", "", "laptop", ["0px", "28px"]],
    ["the drawer", "fitted-drawer", "laptop", ["28px", "24px"]],
    ["a phone's sheet", "", "phone", ["16px", "18px"]],
  ] as const)(
    "takes the footer and the kept title row to the sides of %s, and past its padding",
    (_, classes, screen, [side, top]) => {
      const { part, look } = popup(`fitted-sticky ${classes}`, screen);
      // happy-dom leaves calc() unworked: -1 times the padding.
      const less = (n: string) => `calc(-1*${n})`;
      expect(look(part("fitted-foot"), "margin-left", "padding-left")).toEqual([
        less(side),
        side,
      ]);
      expect(
        look(part("fitted-head"), "margin-left", "margin-top", "padding-top"),
      ).toEqual([less(side), less(top), top]);
    },
  );

  it("keeps the footer at the bottom of a popup with a set height, however short the chart", () => {
    const { part, look } = popup("fitted-drawer");
    expect(look(part("fitted-panel"), "min-height")).toEqual(["100%"]);
    expect(look(part("fitted-body"), "flex-grow")).toEqual(["1"]);
    expect(look(part("fitted-foot"), "margin-top")).toEqual(["auto"]);
  });
});

describe("how the popup opens (§7)", () => {
  it.each([
    ["from the bottom", "", "fitted-up"],
    ["from the right", "fitted-right", "fitted-in"],
    ["fading in", "fitted-fade", "fitted-fade"],
    [
      "from the right as a drawer, whatever Opens from says",
      "fitted-drawer fitted-fade",
      "fitted-in",
    ],
  ])("opens %s", (_, classes, name) => {
    expect(popup(classes).opening()).toBe(name);
  });

  it("takes about a quarter second, as the page dims", () => {
    expect(css).toContain(
      ".fitted-dialog[open]{animation:fitted-up .25s ease-out}",
    );
    expect(css).toContain(
      ".fitted-dialog[open]::backdrop{animation:fitted-fade .25s ease-out}",
    );
  });

  it.each([
    ["the sheet", "fitted-right"],
    ["the sheet for a drawer", "fitted-drawer fitted-fade"],
    ["a card as Opens from says", "fitted-nosheet fitted-fade"],
    ["a drawer from the right", "fitted-nosheet fitted-drawer"],
  ])("raises %s on phones", (_, classes) => {
    const { opening } = popup(classes, "phone");
    const name = /nosheet/.test(classes)
      ? /drawer/.test(classes)
        ? "fitted-in"
        : "fitted-fade"
      : "fitted-up";
    expect(opening()).toBe(name);
  });

  it.each([
    ["", "laptop"],
    ["fitted-drawer", "laptop"],
    ["fitted-right", "phone"],
    ["fitted-nosheet fitted-fade", "phone"],
  ] as const)(
    "opens at once for shoppers who ask for less motion (%s on a %s)",
    (classes, screen) => {
      expect(popup(classes, screen, "reduce").opening()).toBe("");
    },
  );

  it("moves nothing, the backdrop included, outside the rules for shoppers who don't ask for less motion", () => {
    const outside = css.replace(
      /@media \(prefers-reduced-motion:no-preference\)[^{]*\{(?:[^{}]*\{[^{}]*\})*\}/g,
      "",
    );
    expect(outside).not.toMatch(/animation/);
  });
});

describe("the kept title row and table header (§7)", () => {
  it("keeps the title row on top and a fitting table's header under it, with the setting on", () => {
    const { dialog, part, look } = popup("fitted-sticky");
    dialog.style.setProperty("--fitted-top", "90px");
    part("fitted-scroll").classList.add("fitted-flat");
    const th = dialog.querySelector("th")!;
    expect(look(part("fitted-head"), "position", "top", "z-index")).toEqual([
      "sticky",
      "0px",
      "2",
    ]);
    expect(look(part("fitted-scroll"), "overflow")).toEqual(["visible"]);
    expect(look(th, "position", "top")).toEqual(["sticky", "90px"]);
    // Separate borders, which stay with a kept header as collapsed ones don't.
    expect(look(part("fitted-table"), "border-collapse")).toEqual(["separate"]);
    // Focus never lands under the two.
    expect(look(dialog, "scroll-padding-top")).toEqual(["calc(90px + 43px)"]);
  });

  it("leaves a table too wide for the guide its sideways scroll, and keeps nothing with the setting off", () => {
    const wide = popup("fitted-sticky");
    expect(wide.look(wide.part("fitted-scroll"), "overflow-x")).toEqual([
      "auto",
    ]);
    expect(wide.look(wide.dialog.querySelector("th")!, "position")).not.toEqual(
      ["sticky"],
    );
    const { dialog, part, look } = popup("");
    part("fitted-scroll").classList.add("fitted-flat");
    expect(look(part("fitted-head"), "position")).not.toEqual(["sticky"]);
    expect(look(dialog.querySelector("th")!, "position")).not.toEqual([
      "sticky",
    ]);
  });

  it("edges the title row once the guide scrolls", () => {
    const top = popup("fitted-sticky");
    expect(top.look(top.part("fitted-head"), "box-shadow")[0]).not.toMatch(
      /^0 1px /,
    );
    // A fresh popup: happy-dom keeps the styles it read for an element.
    const scrolled = popup("fitted-sticky");
    scrolled.dialog.toggleAttribute("data-fitted-scrolled", true);
    expect(
      scrolled.look(scrolled.part("fitted-head"), "box-shadow")[0],
    ).toMatch(/^0 1px var\(--fitted-line\)|^0 1px color-mix/);
  });
});

describe("the link (§7)", () => {
  it("outlines the Button style in the link's own color, and fills it with the theme's text on hover", () => {
    document.head.innerHTML = `<style>${css}</style>`;
    document.body.innerHTML = `<div class="fitted-guide"><button class="fitted-link fitted-button">Size guide</button></div>`;
    const link = document.querySelector(".fitted-button")!;
    const style = getComputedStyle(link);
    expect([style.borderTopStyle, style.borderTopWidth]).toEqual([
      "solid",
      "1px",
    ]);
    expect(style.textDecoration).toBe("none");
    expect(css).toContain(
      ".fitted-button:hover{background:var(--fitted-text);color:var(--fitted-bg)}",
    );
  });

  it("sizes the store's logo 32px tall, never wider than the popup", () => {
    document.head.innerHTML = `<style>${css}</style>`;
    document.body.innerHTML = `<img class="fitted-logo" alt="">`;
    const style = getComputedStyle(document.querySelector("img")!);
    expect([style.height, style.width, style.maxWidth]).toEqual([
      "32px",
      "auto",
      "100%",
    ]);
  });
});
