import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

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
    [...src.matchAll(/\{\{-?\s*(.*?)\s*-?\}\}/g)].map((m) => m[1]);

  it("prints every value in the data snippet through | json", () => {
    expect(outputs(snippet).length).toBeGreaterThan(5);
    for (const out of outputs(snippet)) expect(out).toMatch(/\| json$/);
  });

  it("prints only the content keys the guide reads, so never content.fit", () => {
    const keys = outputs(snippet).flatMap(
      (o) => /^c\.(\w+) /.exec(o)?.[1] ?? [],
    );
    expect(keys).toEqual(["v", "unit", "roundTo", "tables", "words"]);
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
