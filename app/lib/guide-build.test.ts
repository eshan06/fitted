import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { parseGuide } from "./guide";

// ARCHITECTURE §9: the size guide's scripts are built from app/lib into the
// extension's assets and committed; this is their gate. The banner keeps the
// built files out of ESLint's rules.
const ext = (path: string) =>
  readFileSync(`extensions/size-guide/${path}`, "utf8");
const assets = "extensions/size-guide/assets/";
const banner = "/* eslint-disable */";
const bundles = [
  ["app/lib/guide-entry.ts", "iife", "loader.js"],
  ["app/lib/guide.ts", "esm", "guide.js"],
] as const;

describe("size guide assets", () => {
  it("are built by npm run build:guide with these options", () => {
    const script = JSON.parse(readFileSync("package.json", "utf8")).scripts[
      "build:guide"
    ];
    for (const [entry, format, file] of bundles)
      expect(script).toContain(
        `esbuild ${entry} --bundle --minify --target=es2020 --banner:js='${banner}' --format=${format} --outfile=${assets}${file}`,
      );
  });

  it.each(bundles)("match a fresh build of %s", async (entry, format, file) => {
    const { outputFiles } = await build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      target: "es2020",
      banner: { js: banner },
      format,
      write: false,
    });
    expect(
      ext(`assets/${file}`),
      "Run npm run build:guide and commit the assets",
    ).toBe(outputFiles[0].text);
  });

  it("keep loader.js under Shopify's suggested 10 KB, as the CLI's theme check measures it", () => {
    // Shopify words the limit as compressed, but the check deploy runs
    // (AssetSizeAppBlockJavaScript) measures the file itself.
    expect(Buffer.byteLength(ext("assets/loader.js"))).toBeLessThan(10_000);
  });
});

describe("size guide Liquid", () => {
  const block = ext("blocks/size-guide.liquid");
  const embed = ext("blocks/embed.liquid");
  const guide = ext("snippets/guide.liquid");
  const snippet = ext("snippets/guide-data.liquid");
  const outputs = (src: string) =>
    [...src.matchAll(/\{\{-?\s*([\s\S]*?)\s*-?\}\}/g)].map((m) => m[1]);
  const schema = (src: string) =>
    JSON.parse(
      /\{% schema %\}([\s\S]*?)\{% endschema %\}/.exec(src)?.[1] ?? "",
    );
  // A file's Liquid tags in order, comments aside: what decides its output.
  const tags = (src: string) =>
    [
      ...src
        .replace(/\{%-? comment -?%\}[\s\S]*?\{%-? endcomment -?%\}/g, "")
        .matchAll(/\{%-?\s*([\s\S]*?)\s*-?%\}/g),
    ]
      .map((m) => m[1])
      .filter((t) => !/^(end)?schema$/.test(t));
  // What the data snippet prints for a test chart, keyed by its outputs.
  const values: Record<string, unknown> = {
    "c.v | json": 1,
    "c.unit | json": "in",
    "c.roundTo | json": 0.5,
    "c.tables | json": [
      {
        id: "t1",
        columns: [{ id: "size", kind: "size" }],
        rows: [{ id: "m", cells: {} }],
      },
    ],
    "c.measure | json": { steps: ["m1"] },
    "c.words | json": { "t1.m.size": "M", tips: "Measure snugly." },
    "c.fit | json": {
      table: "t1",
      questions: [{ id: "q1", kind: "usual_size" }],
      ease: {},
      stretch: "none",
    },
    "chart.strings.value | json": { "t1.m.size": "Moyen" },
    "drawing | json":
      "//shop.example.com/cdn/shop/files/measure.png?v=1&width=1000",
    "s.units | json": { default: "cm", toggle: true },
    "s.link | json": { style: "text", icon: "none" },
    "s.popup | json": { rtl: true, font: "theme" },
    "s.placement | json": {
      productBlock: true,
      quickView: true,
      floatingTab: true,
      featured: false,
      selector: ".product-form__input--size",
    },
    "s.colors | json": { mode: "theme" },
    "s.css | json": ".fitted-link { letter-spacing: .1em }",
    "s.text[request.locale.iso_code] | default: s.text[primary.iso_code] | json":
      { label: "Guide des tailles", header: "Tailles", noFit: "Aucune." },
    "localization.country.iso_code | json": "US",
    "request.locale.iso_code | json": "fr",
    "plan | json": "pro",
    "chart.system.handle | json": "c-abc0000001",
    "s.fitFinder | json": { fitBars: true, addToCart: false },
    "p.variants | map: 'id' | json": [44001, 44002],
    "p.variants | map: 'option1' | json": ["M", "M"],
    "p.variants | map: 'option2' | json": ["Black", "White"],
    "p.variants | map: 'option3' | json": [null, null],
  };
  // The data the snippet prints on a store with that plan.
  const printed = (plan: string) =>
    JSON.parse(
      (/<script[^>]*>([\s\S]*)<\/script>/.exec(snippet)?.[1] ?? "")
        .replace(
          /\{% if plan == 'pro' %\}([\s\S]*?)\{% endif %\}/g,
          (_, pro: string) => (plan === "pro" ? pro : ""),
        )
        .replace(/\{\{-?\s*([\s\S]*?)\s*-?\}\}/g, (_, out: string) =>
          JSON.stringify(out === "plan | json" ? plan : values[out]),
        ),
    );

  it("prints only these values, each through | json", () => {
    expect(outputs(snippet)).toEqual(Object.keys(values));
    expect(snippet).not.toMatch(/\becho\b/);
  });

  it("reads only Fitted's own metafields, which no one else writes (§4)", () => {
    expect(snippet).toContain(
      "{%- assign s = shop.metafields['$app'].settings.value -%}",
    );
    expect(snippet).toContain(
      "{%- assign plan = shop.metafields['$app'].plan.value -%}",
    );
    expect(snippet.match(/metafields/g)).toHaveLength(2);
  });

  it("prints the fit finder, the handle that keeps its answers and what Add to cart reads only on Pro (§10)", () => {
    expect(printed("pro")).toMatchObject({
      plan: "pro",
      handle: "c-abc0000001",
      chart: { fit: values["c.fit | json"] },
      fitFinder: { fitBars: true, addToCart: false },
      variants: {
        id: [44001, 44002],
        o1: ["M", "M"],
        o2: ["Black", "White"],
        o3: [null, null],
      },
    });
    for (const plan of ["free", "standard"]) {
      const d = printed(plan);
      expect(d.plan).toBe(plan);
      for (const key of ["handle", "fitFinder", "variants"])
        expect(d).not.toHaveProperty(key);
      expect(d.chart).not.toHaveProperty("fit");
    }
    // The product whose variants it prints is the guide's own.
    expect(guide).toContain("{%- render 'guide-data', chart: chart, p: p -%}");
  });

  it("prints How to measure's steps on every plan, and the drawing only when the chart has one (§9)", () => {
    for (const plan of ["free", "standard", "pro"])
      expect(printed(plan)).toMatchObject({
        chart: { measure: { steps: ["m1"] } },
        measureImage: values["drawing | json"],
      });
    // Without a drawing, drawing stays nil and prints null.
    expect(snippet).toContain(
      [
        "{%- if chart.measure_image.value -%}",
        "  {%- assign drawing = chart.measure_image.value | image_url: width: 1000 -%}",
        "{%- endif -%}",
      ].join("\n"),
    );
  });

  it("prints data that parseGuide reads", () => {
    const json = JSON.stringify(printed("pro"));
    expect(parseGuide(json)).toMatchObject({
      unit: "in",
      roundTo: 0.5,
      sys: "cm",
      locale: "fr",
      words: { "t1.m.size": "Moyen", tips: "Measure snugly." },
      label: "Guide des tailles",
      header: "Tailles",
      icon: "none",
      rtl: true,
      colors: null,
      css: ".fitted-link { letter-spacing: .1em }",
      page: true,
      quick: true,
      featured: false,
      selector: ".product-form__input--size",
    });
  });

  it("prints the guide's words escaped", () => {
    // Shopify's t escapes translations; the product title goes through
    // escape; place and title_id are the block's and embed's own words.
    for (const out of [block, embed, guide].flatMap(outputs))
      expect(out).toMatch(
        /^'size_guide\.\w+' \| t$|^[\w.]+ \| escape$|^'(guide|loader)\.js' \| asset_url$|^title_id$|^place$/,
      );
  });

  it("has a translation for every word it uses, and none it doesn't", () => {
    const used = [...guide.matchAll(/'size_guide\.(\w+)' \| t/g)].map(
      (m) => m[1],
    );
    const en = JSON.parse(ext("locales/en.default.json")).size_guide;
    expect(new Set(used)).toEqual(new Set(Object.keys(en)));
    expect([block, embed].join()).not.toContain("size_guide.");
  });

  it("prints Find my size's words only on Pro, the plan that shows it (§10)", () => {
    const [, before, pro] =
      /([\s\S]*)\{%- if shop\.metafields\['\$app'\]\.plan\.value == 'pro' %\}([\s\S]*?)\{%- endif %\}/.exec(
        guide,
      ) ?? [];
    const used = (src = "") =>
      [...src.matchAll(/data-t-(\w+)=/g)].map((m) => m[1]);
    expect(used(pro)).toEqual(expect.arrayContaining(["fit", "recommend"]));
    // How to measure and the tab bar show on every plan (§9).
    expect(used(before)).toEqual(
      expect.arrayContaining([
        "chart",
        "select",
        "sections",
        "measure",
        "line_first",
        "line",
        "drawing",
      ]),
    );
    expect(used(before)).not.toContain("fit");
  });

  it("keeps {size} in the words the guide fills with a size", () => {
    const en = JSON.parse(ext("locales/en.default.json")).size_guide;
    for (const key of ["choose", "selected", "select"])
      expect(en[key]).toContain("{size}");
  });

  it("is an app block that loads loader.js for the product it sits on", () => {
    expect(schema(block)).toMatchObject({
      target: "content",
      javascript: "loader.js",
    });
    expect(schema(block).settings).toContainEqual(
      expect.objectContaining({ type: "product", autofill: true }),
    );
  });

  it("puts the app block's guide on its product page as main, and elsewhere as featured", () => {
    expect(tags(block)).toEqual([
      "assign p = block.settings.product",
      "assign chart = p.metafields['$app'].chart.value",
      "if chart",
      "assign place = 'featured'",
      "if template.name == 'product' and p.id == product.id",
      "assign place = 'main'",
      "endif",
      "render 'guide', p: p, chart: chart, id: block.id, place: place",
      "endif",
    ]);
  });

  it("is an app embed that prints the tab and the selector's link on a product page with a chart, and loads loader.js only where needed", () => {
    // No javascript in the schema: that would load loader.js on every page.
    expect(schema(embed)).toEqual({ name: "Size guide", target: "body" });
    expect(tags(embed)).toEqual([
      "assign s = shop.metafields['$app'].settings.value",
      "assign chart = product.metafields['$app'].chart.value",
      "assign load = s.placement.quickView",
      "if template.name == 'product' and chart",
      "if s.placement.floatingTab or s.link.style == 'tab'",
      "render 'guide', p: product, chart: chart, id: 'tab', place: 'tab'",
      "assign load = true",
      "endif",
      "if s.link.style == 'tab'",
      "endif",
      "if s.placement.selector != blank",
      "render 'guide', p: product, chart: chart, id: 'after', place: 'after'",
      "assign load = true",
      "endif",
      "endif",
      "if load",
      "endif",
    ]);
    expect(embed).toContain(
      `<script src="{{ 'loader.js' | asset_url }}" defer></script>`,
    );
    // What stands in for the app block's link: guide-loader.test.ts runs these.
    const hide = embed.match(/<style>[\s\S]*?<\/style>/g);
    expect(hide).toEqual([
      "<style>.fitted-guide[data-page]>.fitted-link{display:none!important}</style>",
      "<style>body:has(.fitted-guide[data-placed]) .fitted-guide[data-page]>.fitted-link{display:none!important}</style>",
    ]);
    expect(embed.indexOf(hide![0])).toBeGreaterThan(
      embed.indexOf("if s.link.style == 'tab' -%}"),
    );
  });

  it("names the chart and product for guide.js's events, except in the theme editor (§12)", () => {
    expect(guide).toContain(
      [
        "{%- unless request.design_mode %}",
        'data-chart="gid://shopify/Metaobject/{{ chart.system.id | escape }}"',
        'data-product="gid://shopify/Product/{{ p.id | escape }}"',
        "{%- endunless %}",
      ].join("\n  "),
    );
    expect(guide.match(/data-(chart|product)=/g)).toHaveLength(2);
  });

  it("prints the tab's styles only with the tab", () => {
    const style =
      /\{%- if place == 'tab' -%\}\s*<style>([\s\S]*?)<\/style>/.exec(
        guide,
      )?.[1];
    expect(style).toContain(".fitted-tab{position:fixed;");
    expect(guide.match(/<style>/g)).toHaveLength(1);
  });
});
