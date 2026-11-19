import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ARCHITECTURE §16: each subscription in shopify.app.toml is handled by
// app/routes/webhooks.<path, dots for slashes>.tsx, and each handler is subscribed.
describe("webhook subscriptions", () => {
  it("match the webhook handler routes one to one", () => {
    const toml = readFileSync(
      new URL("../../shopify.app.toml", import.meta.url),
      "utf8",
    );
    const subscribed = [...toml.matchAll(/^\s*uri\s*=\s*"([^"]+)"/gm)].map(
      ([, uri]) => uri,
    );
    const handled = readdirSync(new URL(".", import.meta.url))
      .filter((f) => f.startsWith("webhooks.") && !/\.test\.tsx?$/.test(f))
      .map((f) => "/" + f.replace(/\.tsx?$/, "").replaceAll(".", "/"));

    expect(subscribed.sort()).toEqual(handled.sort());
  });
});
