// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reasonText } from "../components/fit-finder/chart-fit";
import { findSize, type Answers, type Fit, type Table } from "./fit-finder";
import { parseGuide, render } from "./guide";

// Find my size (ARCHITECTURE §10), from the Storefront and FitFinder boards.
const en = JSON.parse(
  readFileSync("extensions/size-guide/locales/en.default.json", "utf8"),
).size_guide;

// Women's tops in inches, fit-finder.test.ts's chart, with its words.
const tops: Table = {
  id: "tops",
  columns: [
    { id: "size", kind: "size" },
    { id: "bust", kind: "measure", convert: true },
    { id: "waist", kind: "measure", convert: true },
    { id: "wt", kind: "measure", unit: "lb", convert: true },
    { id: "note", kind: "text" },
  ],
  rows: [
    { id: "xs", cells: { bust: [31, 32], waist: [24, 25], wt: [100, 115] } },
    { id: "s", cells: { bust: [33, 34], waist: [26, 27], wt: [115, 130] } },
    { id: "m", cells: { bust: [35, 36], waist: [28, 29], wt: [130, 145] } },
    { id: "l", cells: { bust: [37.5, 39], waist: [30.5, 32] } },
    { id: "xl", cells: { bust: [40.5, 42], waist: [33.5, 35] } },
  ],
};
const sizes = { xs: "XS", s: "S", m: "M", l: "L", xl: "XL" };
const words: Record<string, string> = {
  "tops.size": "Size",
  "tops.bust": "Bust",
  "tops.waist": "Waist",
  "tops.wt": "Weight",
  ...Object.fromEntries(
    Object.entries(sizes).map(([row, w]) => [`tops.${row}.size`, w]),
  ),
  "fit.q1": "What's your bust measurement?",
  "fit.q2": "What size do you usually wear?",
  "fit.q3": "How do you like tops to fit?",
  "fit.q4": "Which best describes your shoulders?",
  "fit.q4.narrow": "Narrow",
  "fit.q4.average": "Average",
  "fit.q4.broad": "Broad",
  "fit.q5": "What's your waist measurement?",
  "fit.q6": "What do you weigh?",
};
const fit: Fit = {
  table: "tops",
  questions: [
    { id: "q1", kind: "measure", col: "bust", optional: true },
    { id: "q2", kind: "usual_size" },
    { id: "q3", kind: "fit" },
  ],
  ease: {},
  stretch: "none",
};
const shoulders = {
  id: "q4",
  kind: "choice",
  options: [
    { id: "narrow", rows: ["xs", "s"] },
    { id: "average", rows: ["m"] },
    { id: "broad", rows: ["l", "xl"] },
  ],
};
// What the data snippet prints on Pro (§9).
const data = (f: unknown = {}, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    chart: {
      v: 1,
      unit: "in",
      roundTo: 0.5,
      tables: [tops],
      words,
      fit: { ...fit, ...(f as object) },
    },
    strings: {},
    units: { default: "country", toggle: true },
    country: "US",
    locale: "en",
    plan: "pro",
    handle: "c-tops000001",
    ...over,
  });
// The guide with the extension's words on its root, as the block passes them,
// on the page, where its radios work.
const open = (
  json: string,
  root: HTMLElement = document.createElement("div"),
) => {
  const g = parseGuide(json);
  if (!g) throw new Error("expected a guide");
  for (const [k, v] of Object.entries<string>(en))
    root.dataset[`t${k[0].toUpperCase()}${k.slice(1)}`] ??= v;
  if (!root.isConnected) document.body.append(root);
  render(root, g);
  return root;
};
const texts = (root: Element, selector: string) =>
  [...root.querySelectorAll(selector)].map((el) => el.textContent);
const tabs = (root: Element) =>
  [...root.querySelectorAll<HTMLButtonElement>(".fitted-tabs button")].map(
    (b) => [b.textContent, b.getAttribute("aria-pressed")],
  );
const fields = (root: Element, q: string) => [
  ...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    `[data-q="${q}"]`,
  ),
];
const fire = (el: Element, ...types: string[]) =>
  types.forEach((type) => el.dispatchEvent(new Event(type, { bubbles: true })));
// Typing, then leaving the field.
const type = (root: Element, q: string, text: string) => {
  const [el] = fields(root, q);
  el.value = text;
  fire(el, "input", "change");
  return el.value;
};
// Picking a usual size, a fit or a choice.
const pick = (root: Element, q: string, value: string) => {
  const els = fields(root, q);
  const radio = els.find((el) => el.value === value && el.type === "radio");
  if (radio) return (radio as HTMLInputElement).click();
  els[0].value = value;
  fire(els[0], "input", "change");
};
// What the result says, or null while it waits for answers.
const said = (root: Element) => {
  const out = root.querySelector<HTMLElement>(".fitted-result")!;
  return out.hidden ? null : [...out.children].map((el) => el.textContent);
};
const answer = (root: Element, a: Record<string, string>) => {
  for (const [q, v] of Object.entries(a))
    if (q === "q1" || q === "q5" || q === "q6") type(root, q, v);
    else pick(root, q, v);
  return said(root);
};

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("Find my size", () => {
  it("shows only on Pro, for a chart with a fit finder (§10)", () => {
    expect(tabs(open(data()))).toEqual([
      ["Size chart", "true"],
      ["Find my size", "false"],
    ]);
    expect(
      open(data()).querySelector(".fitted-tabs")?.getAttribute("aria-label"),
    ).toBe("Size guide sections");
    for (const plan of ["free", "standard", null]) {
      const root = open(data({}, { plan }));
      // One tab: no tab bar (§9), and the Size chart as before.
      expect(root.querySelector(".fitted-tabs, .fitted-fit")).toBeNull();
      expect(root.querySelector("table")).not.toBeNull();
    }
    const none = JSON.parse(data());
    delete none.chart.fit;
    expect(open(JSON.stringify(none)).querySelector(".fitted-tabs")).toBeNull();
  });

  it.each([
    ["a table the chart doesn't have", { table: "dresses" }],
    ["an unknown stretch", { stretch: "lots" }],
    ["ease that isn't numbers", { ease: { bust: "2" } }],
    ["no ease", { ease: null }],
    ["no questions", { questions: [] }],
    ["seven questions", { questions: Array(7).fill(fit.questions[0]) }],
    ["an unknown kind", { questions: [{ id: "q1", kind: "slider" }] }],
    [
      "a measurement of a text column",
      { questions: [{ id: "q1", kind: "measure", col: "note" }] },
    ],
    [
      "a measurement of a column the table doesn't have",
      { questions: [{ id: "q1", kind: "measure", col: "hips" }] },
    ],
    [
      "a question id that isn't one",
      { questions: [{ id: '"><img src=x>', kind: "fit" }] },
    ],
    [
      "a choice without options",
      { questions: [{ id: "q4", kind: "choice", options: [] }] },
    ],
    [
      "an option without sizes",
      {
        questions: [
          { id: "q4", kind: "choice", options: [{ id: "a", rows: [] }] },
        ],
      },
    ],
  ])("leaves out %s, and still draws the Size chart", (_, f) => {
    const root = open(data(f));
    expect(root.querySelector(".fitted-tabs, .fitted-fit")).toBeNull();
    expect(root.querySelector("table")).not.toBeNull();
  });

  it("switches between the Size chart and Find my size, the footer going with the chart", () => {
    const root = open(data());
    const [chart, finder] = root.querySelectorAll<HTMLElement>(
      ".fitted-tabs button",
    );
    const pane = root.querySelector<HTMLElement>(".fitted-fit")!;
    const sizes = root.querySelector<HTMLElement>(":scope > .fitted-part")!;
    expect(sizes.contains(root.querySelector("table"))).toBe(true);
    expect([sizes.hidden, pane.hidden]).toEqual([false, true]);
    root.querySelector<HTMLElement>("tbody td")!.click();
    finder.click();
    expect([sizes.hidden, pane.hidden]).toEqual([true, false]);
    expect(sizes.contains(root.querySelector(".fitted-foot"))).toBe(true);
    expect(tabs(root).map(([, on]) => on)).toEqual(["false", "true"]);
    chart.click();
    expect([sizes.hidden, pane.hidden]).toEqual([false, true]);
    // The pick made before stays.
    expect(texts(root, ".fitted-on th")).toEqual(["XS"]);
  });

  it("asks the chart's questions in order, in their words, as drawn", () => {
    const root = open(data());
    const pane = root.querySelector(".fitted-fit")!;
    expect(texts(pane, ":scope > label")).toEqual([
      "What's your bust measurement? (optional)",
      "What size do you usually wear?XSSMLXL",
    ]);
    const [bust] = fields(root, "q1");
    expect([bust.type, bust.getAttribute("inputmode"), bust.name]).toEqual([
      "text",
      "decimal",
      "",
    ]);
    const [usual] = fields(root, "q2") as HTMLSelectElement[];
    expect([...usual.options].map((o) => [o.value, o.text])).toEqual([
      ["", ""],
      ["xs", "XS"],
      ["s", "S"],
      ["m", "M"],
      ["l", "L"],
      ["xl", "XL"],
    ]);
    expect(texts(pane, ".fitted-fine")).toEqual([
      "No tape measure? Leave bust empty and we'll start from the size you usually wear.",
    ]);
    expect(texts(pane, "legend")).toEqual(["How do you like tops to fit?"]);
    expect(texts(pane, ".fitted-opt")).toEqual(["Snug", "Regular", "Relaxed"]);
    expect(fields(root, "q3").map((el) => el.value)).toEqual([
      "snug",
      "regular",
      "relaxed",
    ]);
  });

  it("names every measurement the usual size stands in for, and only when all can be skipped", () => {
    const waist = { id: "q5", kind: "measure", col: "waist", optional: true };
    const both = open(data({ questions: [...fit.questions, waist] }));
    expect(texts(both, ".fitted-fine")).toEqual([
      "No tape measure? Leave bust and waist empty and we'll start from the size you usually wear.",
    ]);
    const required = { ...waist, optional: false };
    const one = open(data({ questions: [...fit.questions, required] }));
    expect(one.querySelector(".fitted-fine")).toBeNull();
    expect(texts(one, ".fitted-fit > label")[2]).toBe(
      "What's your waist measurement?",
    );
    const none = open(data({ questions: [fit.questions[1]] }));
    expect(none.querySelector(".fitted-fine")).toBeNull();
  });

  it("draws a choice's answers in their words", () => {
    const root = open(data({ questions: [shoulders] }));
    expect(texts(root, "legend")).toEqual([
      "Which best describes your shoulders?",
    ]);
    expect(texts(root, ".fitted-opt")).toEqual(["Narrow", "Average", "Broad"]);
  });

  it("prints the merchant's words as text, never as HTML", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const json = JSON.parse(data({ questions: [fit.questions[0], shoulders] }));
    Object.assign(json.chart.words, {
      "fit.q1": evil,
      "fit.q4": evil,
      "fit.q4.narrow": evil,
    });
    const root = open(JSON.stringify(json));
    expect(root.querySelector("img")).toBeNull();
    expect(texts(root, ".fitted-fit > label")[0]).toBe(`${evil} (optional)`);
    expect(texts(root, "legend")).toEqual([evil]);
    expect(texts(root, ".fitted-opt")[0]).toBe(evil);
  });

  it("waits for every question a shopper can't skip", () => {
    const root = open(data());
    expect(said(root)).toBeNull();
    type(root, "q1", "35.5");
    pick(root, "q2", "m");
    expect(said(root)).toBeNull();
    pick(root, "q3", "regular");
    expect(said(root)).not.toBeNull();
    // A measurement that can't be skipped holds it back too.
    sessionStorage.clear();
    const q1 = { ...fit.questions[0], optional: false };
    const must = open(data({ questions: [q1, fit.questions[2]] }));
    pick(must, "q3", "regular");
    expect(said(must)).toBeNull();
    type(must, "q1", "35.5");
    expect(said(must)).not.toBeNull();
    // With nothing that has to be answered, the first answer shows it.
    sessionStorage.clear();
    const all = open(data({ questions: [fit.questions[0]] }));
    expect(said(all)).toBeNull();
    type(all, "q1", "35.5");
    expect(said(all)).toEqual([
      "We recommend M",
      "Your 35.5 in bust falls in M on this chart.",
    ]);
    // A fit alone is nothing to go on: no "no size fits" before a measurement.
    sessionStorage.clear();
    const bare = open(
      data({ questions: [fit.questions[0], fit.questions[2]] }),
    );
    pick(bare, "q3", "regular");
    expect(said(bare)).toBeNull();
    type(bare, "q1", "35.5");
    expect(said(bare)?.[0]).toBe("We recommend M");
  });

  it("recommends the Storefront board's size, saying why", () => {
    const root = open(data());
    expect(answer(root, { q1: "35.5", q2: "m", q3: "regular" })).toEqual([
      "We recommend M",
      "Your 35.5 in bust falls in M on this chart, and you like a regular fit.",
    ]);
    expect(root.querySelector(".fitted-result h3 span")?.textContent).toBe("M");
    // Screen readers hear it from a status line that's there from the start.
    expect(root.querySelector(".fitted-fit [role=status]")?.textContent).toBe(
      "We recommend M Your 35.5 in bust falls in M on this chart, and you like a regular fit.",
    );
  });

  // The engine's tests' shoppers, in the words the shopper reads.
  it.each<[Record<string, string>, Partial<Fit>, string, string]>([
    [
      { q1: "35.5", q2: "m", q3: "regular" },
      { ease: { bust: 2 } },
      "L",
      "Your 35.5 in bust with 2 in of ease falls in L on this chart, and you like a regular fit.",
    ],
    [
      { q1: "35.5", q2: "m", q3: "relaxed" },
      {},
      "L",
      "Your 35.5 in bust falls in M on this chart, and you like a relaxed fit, so L.",
    ],
    [
      { q1: "35.5", q2: "m", q3: "snug" },
      {},
      "S",
      "Your 35.5 in bust falls in M on this chart, and you like a snug fit, so S.",
    ],
    [
      { q1: "37", q2: "m", q3: "regular" },
      {},
      "L",
      "Your 37 in bust falls between M and L on this chart, and you like a regular fit, so L.",
    ],
    [
      { q1: "37", q2: "m", q3: "snug" },
      {},
      "M",
      "Your 37 in bust falls between M and L on this chart, and you like a snug fit, so M.",
    ],
    [
      { q1: "36.5", q2: "m", q3: "regular" },
      { stretch: "some" },
      "M",
      "Your 36.5 in bust falls in M on this chart, counting the fabric's stretch, and you like a regular fit.",
    ],
    [
      { q2: "m", q3: "regular" },
      {},
      "M",
      "You usually wear M, and you like a regular fit.",
    ],
    [
      { q2: "m", q3: "relaxed" },
      {},
      "L",
      "You usually wear M, and you like a relaxed fit, so L.",
    ],
    [
      { q2: "xl", q3: "relaxed" },
      {},
      "XL",
      "You usually wear XL, and you like a relaxed fit.",
    ],
  ])("for %o on %o recommends %s", (a, f, size, why) => {
    const root = open(data(f));
    expect(answer(root, a)).toEqual([`We recommend ${size}`, why]);
    const engine = findSize(
      { unit: "in", tables: [tops], fit: { ...fit, ...f } },
      {
        q1: a.q1 ? { value: Number(a.q1), unit: "in" } : undefined,
        q2: a.q2,
        q3: a.q3,
      },
    );
    expect(sizes[engine.row as keyof typeof sizes]).toBe(size);
  });

  it("says the merchant's words when no size fits, then why", () => {
    const noFit = "Nothing on this chart fits.";
    const root = open(data({}, { text: { noFit } }));
    expect(answer(root, { q1: "50", q2: "m", q3: "regular" })).toEqual([
      noFit,
      "Your 50 in bust is past XL, the largest size on this chart.",
    ]);
    expect(root.querySelector(".fitted-result h3 span")).toBeNull();
    // Without the merchant's words, the extension's.
    const small = open(data({}, { text: { noFit: "One\nTwo" } }));
    expect(answer(small, { q1: "30", q2: "m", q3: "regular" })).toEqual([
      "We couldn't find a good match. Check the size chart or message us.",
      "Your 30 in bust is below XS, the smallest size on this chart.",
    ]);
  });

  it("keeps only the sizes a choice leaves", () => {
    const root = open(data({ questions: [shoulders] }));
    pick(root, "q4", "average");
    expect(said(root)).toEqual([
      "We recommend M",
      "Your answers leave only M on this chart.",
    ]);
    // More than one left, and nothing else to go on: no size fits.
    pick(root, "q4", "broad");
    expect(said(root)).toEqual([
      "We couldn't find a good match. Check the size chart or message us.",
    ]);
  });

  it("words its reasons as the admin's preview does (#134)", () => {
    const chart = {
      id: "gid://shopify/Metaobject/1",
      updatedAt: "",
      name: "Women's tops",
      unit: "in" as const,
      table: tops,
      words,
    };
    // A bust in inches, if any, then the usual size; always a regular fit,
    // the one the preview's shopper likes.
    const cases: [number | null, string, Partial<Fit>][] = [
      [35.5, "m", {}],
      [35.5, "m", { ease: { bust: 1.5 } }],
      [36.5, "m", { stretch: "high" }],
      [37, "m", {}],
      [50, "m", {}],
      [35.5, "m", { ease: { bust: -6 } }],
      [null, "s", {}],
    ];
    for (const [bust, usual, f] of cases) {
      sessionStorage.clear();
      const root = open(data(f));
      const typed: Record<string, string> =
        bust === null ? {} : { q1: `${bust}` };
      const shown = answer(root, { ...typed, q2: usual, q3: "regular" });
      const full = { ...fit, ...f };
      const a: Answers = { q2: usual, q3: "regular" };
      if (bust !== null) a.q1 = { value: bust, unit: "in" };
      const result = findSize({ unit: "in", tables: [tops], fit: full }, a);
      expect(shown?.at(-1)).toBe(reasonText({ ...chart, fit: full }, result));
    }
  });

  it("reads a measurement in the unit it names, else in the guide's units, and writes it out", () => {
    const root = open(data({ questions: [fit.questions[0]] }));
    expect(type(root, "q1", "35.5")).toBe("35.5 in");
    expect(type(root, "q1", "90 cm")).toBe("90 cm");
    expect(said(root)?.[1]).toBe("Your 90 cm bust falls in M on this chart.");
    expect(type(root, "q1", "35,5")).toBe("35.5 in");
    expect(type(root, "q1", " 35.5IN ")).toBe("35.5 in");
    // A unit of another kind, or none Fitted knows, is the guide's units.
    expect(type(root, "q1", "35.5 kg")).toBe("35.5 in");
    expect(type(root, "q1", "35.5 inches")).toBe("35.5 in");
    // No number: no answer, and the field keeps what was typed.
    expect(type(root, "q1", "abc")).toBe("abc");
    expect(said(root)).toBeNull();
    expect(type(root, "q1", "0")).toBe("0");
    expect(said(root)).toBeNull();
    // The in/cm toggle on the Size chart tab sets the units it assumes.
    root.querySelector<HTMLElement>('[data-fitted-sys="cm"]')!.click();
    expect(type(root, "q1", "90")).toBe("90 cm");
  });

  it("names the ease in the unit the shopper typed, rounded as the chart rounds", () => {
    const root = open(data({ ease: { bust: 2 } }));
    expect(answer(root, { q1: "90 cm", q2: "m", q3: "regular" })).toEqual([
      "We recommend L",
      "Your 90 cm bust with 5 cm of ease falls between M and L on this chart, and you like a regular fit, so L.",
    ]);
  });

  it("assumes the shopper's units: centimeters and kilograms outside the US, with commas where they're written", () => {
    const weight = { id: "q6", kind: "measure", col: "wt", optional: true };
    const root = open(
      data(
        { questions: [fit.questions[0], weight] },
        { country: "DE", locale: "de" },
      ),
    );
    expect(type(root, "q1", "90")).toBe("90 cm");
    expect(type(root, "q1", "89,5")).toBe("89,5 cm");
    expect(type(root, "q6", "61")).toBe("61 kg");
    expect(type(root, "q6", "135 lb")).toBe("135 lb");
  });

  it("keeps the answers in sessionStorage alone, for the next product with this chart", () => {
    const root = open(data());
    answer(root, { q1: "35.5", q2: "m", q3: "regular" });
    expect(
      JSON.parse(sessionStorage.getItem("fitted:answers:c-tops000001")!),
    ).toEqual({ q1: { value: 35.5, unit: "in" }, q2: "m", q3: "regular" });
    expect(sessionStorage).toHaveLength(1);

    const next = open(data());
    expect(fields(next, "q1")[0].value).toBe("35.5 in");
    expect(fields(next, "q2")[0].value).toBe("m");
    expect(
      fields(next, "q3").map((el) => (el as HTMLInputElement).checked),
    ).toEqual([false, true, false]);
    expect(said(next)?.[0]).toBe("We recommend M");
    // Another chart starts empty.
    const other = open(data({}, { handle: "c-dresses001" }));
    expect(fields(other, "q1")[0].value).toBe("");
    expect(said(other)).toBeNull();
  });

  it("starts empty from stored answers it can't use", () => {
    const key = "fitted:answers:c-tops000001";
    sessionStorage.setItem(
      key,
      JSON.stringify({ q1: { value: "35", unit: "in" }, q2: "<b>", q3: 1 }),
    );
    const root = open(data());
    expect(fields(root, "q1")[0].value).toBe("");
    expect(fields(root, "q2")[0].value).toBe("");
    expect(root.querySelector(".fitted-fit :checked")).toBeNull();
    sessionStorage.setItem(
      key,
      JSON.stringify({ q1: { value: 35, unit: "mm" } }),
    );
    expect(fields(open(data()), "q1")[0].value).toBe("");
    // A weight's unit under a question that measures a length.
    sessionStorage.setItem(
      key,
      JSON.stringify({ q1: { value: 35, unit: "kg" } }),
    );
    expect(fields(open(data()), "q1")[0].value).toBe("");
    sessionStorage.setItem(key, "{");
    expect(fields(open(data()), "q1")[0].value).toBe("");
  });

  it("stores nothing without the chart's handle", () => {
    for (const handle of [undefined, 5, null]) {
      answer(open(data({}, { handle })), { q2: "m", q3: "regular" });
      expect(sessionStorage).toHaveLength(0);
    }
  });

  it("still works where sessionStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(answer(open(data()), { q2: "m", q3: "regular" })?.[0]).toBe(
      "We recommend M",
    );
  });

  it("keeps its fields in a form of their own that never submits, so no request carries an answer", () => {
    const root = open(data({ questions: [...fit.questions, shoulders] }));
    const pane = root.querySelector<HTMLFormElement>(".fitted-fit")!;
    const submit = new Event("submit", { cancelable: true });
    pane.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    for (const el of pane.querySelectorAll<HTMLInputElement>("input, select"))
      expect(el.form).toBe(pane);
    // Only radios are named, so they group within their own form.
    expect(
      [...pane.querySelectorAll<HTMLInputElement>("[name]")].map(
        (el) => el.type,
      ),
    ).toEqual(Array(6).fill("radio"));
  });

  it("keeps its form's events from a theme's form around the guide, so Enter adds nothing to the cart", () => {
    // The embed's link placed inside a theme's product form.
    document.body.innerHTML = `<form action="/cart/add"><div class="fitted-guide"><div></div></div></form>`;
    const theme = document.querySelector("form")!;
    const heard: string[] = [];
    for (const type of ["submit", "input", "change"])
      theme.addEventListener(type, (e) => heard.push(e.type));
    const root = open(
      data(),
      document.querySelector<HTMLElement>(".fitted-guide > div")!,
    );
    const pane = root.querySelector<HTMLFormElement>(".fitted-fit")!;
    // What pressing Enter in the bust field fires.
    const enter = new Event("submit", { bubbles: true, cancelable: true });
    pane.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    answer(root, { q1: "35.5", q2: "m", q3: "regular" });
    expect(heard).toEqual([]);
    expect(said(root)?.[0]).toBe("We recommend M");
  });
});

describe("Find my size beside the theme's product form", () => {
  // The block above a theme's size radios, whose size rows' ids are their
  // lowercased labels, as the usual-size answers' values are.
  const page = () => {
    document.body.innerHTML = `<div class="shopify-section"><div><div class="fitted-guide"><dialog><div class="fitted-body"></div></dialog></div>${[
      "XS",
      "S",
      "M",
    ]
      .map(
        (s) =>
          `<input type="radio" name="Size" value="${s}"${s === "M" ? " checked" : ""}>`,
      )
      .join("")}<form action="/cart/add"></form></div></div>`;
    const root = document.querySelector<HTMLElement>(".fitted-body")!;
    return open(data(), root);
  };
  const theme = (size: string) =>
    document.querySelector<HTMLInputElement>(
      `input[name="Size"][value="${size}"]`,
    )!;

  it("never takes Find my size's own answers for the theme's size controls", () => {
    sessionStorage.setItem(
      "fitted:answers:c-tops000001",
      JSON.stringify({ q2: "s", q3: "regular" }),
    );
    const root = page();
    // Opens on the size the form shows, not the shopper's usual size.
    expect(texts(root, ".fitted-on th")).toEqual(["M"]);
    root.querySelector<HTMLElement>("tbody tr:nth-child(2) td")!.click();
    const go = root.querySelector<HTMLButtonElement>("[data-fitted-select]")!;
    expect([go.hidden, go.textContent]).toEqual([false, "Select S"]);
    go.click();
    expect(theme("S").checked).toBe(true);
    expect(fields(root, "q2")[0].value).toBe("s");
  });
});

describe("Find my size's events (§12)", () => {
  // A block that names its chart and product, as the snippet prints it.
  const block = () => {
    const el = document.body.appendChild(document.createElement("div"));
    el.className = "fitted-guide";
    el.dataset.chart = "gid://shopify/Metaobject/1301";
    el.dataset.product = "gid://shopify/Product/8812";
    return open(data(), el.appendChild(document.createElement("div")));
  };
  const sent = (beacon: { mock: { calls: unknown[][] } }) =>
    beacon.mock.calls.map(([, body]) => JSON.parse(body as string));

  it("tells Fitted each new result as the shopper settles on it, naming only its size row", () => {
    const beacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    const root = block();
    beacon.mockClear(); // the open
    answer(root, { q1: "35.5", q2: "m", q3: "regular" });
    // Typing, digit by digit, changes nothing until the shopper leaves the
    // field: no passing result, and nothing told.
    const [bust] = fields(root, "q1");
    for (const text of ["3", "37"]) {
      bust.value = text;
      fire(bust, "input");
      expect(said(root)?.[0]).toBe("We recommend M");
    }
    expect(beacon).toHaveBeenCalledTimes(1);
    fire(bust, "change");
    // Relaxed leaves a pick between sizes as it is: the same result again.
    pick(root, "q3", "relaxed");
    type(root, "q1", "50");
    expect(sent(beacon)).toEqual([
      expect.objectContaining({ type: "fit_result", size: "m" }),
      expect.objectContaining({ type: "fit_result", size: "l" }),
      expect.not.objectContaining({ size: expect.anything() }),
    ]);
    for (const event of sent(beacon))
      expect(Object.keys(event).sort()).toEqual(
        event.size
          ? ["chart", "id", "product", "size", "type"]
          : ["chart", "id", "product", "type"],
      );
    expect(
      beacon.mock.calls.every(([url]) => url === "/apps/fitted/events"),
    ).toBe(true);
  });

  it("sends nothing from a guide that names no chart, as in the admin preview", () => {
    const beacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    answer(open(data()), { q1: "35.5", q2: "m", q3: "regular" });
    expect(beacon).not.toHaveBeenCalled();
  });
});
