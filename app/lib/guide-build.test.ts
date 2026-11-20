import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
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

  it("keep loader.js under Shopify's suggested 10 KB compressed", () => {
    expect(gzipSync(ext("assets/loader.js")).length).toBeLessThan(10_000);
  });
});

describe("size guide Liquid", () => {
  const block = ext("blocks/size-guide.liquid");
  const snippet = ext("snippets/guide-data.liquid");
  const outputs = (src: string) =>
    [...src.matchAll(/\{\{-?\s*([\s\S]*?)\s*-?\}\}/g)].map((m) => m[1]);
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
    });
  });

  it("prints the block's words escaped", () => {
    // Shopify's t escapes translations; the product title goes through escape.
    for (const out of outputs(block))
      expect(out).toMatch(
        /^'size_guide\.\w+' \| t$|^[\w.]+ \| escape$|^'guide\.js' \| asset_url$|^title_id$/,
      );
  });

  it("has a translation for every word it uses, and none it doesn't", () => {
    const used = [...block.matchAll(/'size_guide\.(\w+)' \| t/g)].map(
      (m) => m[1],
    );
    const en = JSON.parse(ext("locales/en.default.json")).size_guide;
    expect(new Set(used)).toEqual(new Set(Object.keys(en)));
  });

  it("keeps {size} in the words the guide fills with a size", () => {
    const en = JSON.parse(ext("locales/en.default.json")).size_guide;
    for (const key of ["choose", "selected", "select"])
      expect(en[key]).toContain("{size}");
  });

  it("is an app block that loads loader.js for the product it sits on", () => {
    const schema = JSON.parse(
      /\{% schema %\}([\s\S]*?)\{% endschema %\}/.exec(block)?.[1] ?? "",
    );
    expect(schema).toMatchObject({
      target: "content",
      javascript: "loader.js",
    });
    expect(schema.settings).toContainEqual(
      expect.objectContaining({ type: "product", autofill: true }),
    );
  });
});
