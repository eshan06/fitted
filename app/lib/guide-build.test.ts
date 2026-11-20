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
    "c.words | json": { "t1.m.size": "M", tips: "Measure snugly." },
    "chart.strings.value | json": { "t1.m.size": "Moyen" },
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
  };

  it("prints only these values, each through | json, so never content.fit", () => {
    expect(outputs(snippet)).toEqual(Object.keys(values));
    expect(snippet).not.toMatch(/\becho\b/);
  });

  it("reads settings only from Fitted's own metafield, which no one else writes (§4)", () => {
    expect(snippet).toContain(
      "{%- assign s = shop.metafields['$app'].settings.value -%}",
    );
    expect(snippet.match(/metafields/g)).toHaveLength(1);
  });

  it("prints data that parseGuide reads", () => {
    const json = (
      /<script[^>]*>([\s\S]*)<\/script>/.exec(snippet)?.[1] ?? ""
    ).replace(/\{\{-?\s*([\s\S]*?)\s*-?\}\}/g, (_, out: string) =>
      JSON.stringify(values[out]),
    );
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
      page: false, // a selector takes the app block's place
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
