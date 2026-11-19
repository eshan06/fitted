import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ARCHITECTURE §16: each subscription in shopify.app.toml is handled by
// app/routes/webhooks.<path, dots for slashes>.tsx, and each handler is subscribed.
describe("webhook subscriptions", () => {
  const toml = readFileSync(
    new URL("../../shopify.app.toml", import.meta.url),
    "utf8",
  );

  it("match the webhook handler routes one to one", () => {
    const subscribed = [...toml.matchAll(/^\s*uri\s*=\s*"([^"]+)"/gm)].map(
      ([, uri]) => uri,
    );
    const handled = readdirSync(new URL(".", import.meta.url))
      .filter((f) => f.startsWith("webhooks.") && !/\.test\.tsx?$/.test(f))
      .map((f) => "/" + f.replace(/\.tsx?$/, "").replaceAll(".", "/"));

    expect(subscribed.sort()).toEqual(handled.sort());
  });

  it("send each privacy topic to its own handler", () => {
    // A customers/redact sent to shop/redact would erase the whole shop's data.
    const routed = toml
      .split("[[webhooks.subscriptions]]")
      .slice(1)
      .flatMap((subscription) => {
        const uri = subscription.match(/^\s*uri\s*=\s*"([^"]+)"/m)?.[1];
        const list = subscription.match(
          /^\s*compliance_topics\s*=\s*\[([^\]]*)\]/m,
        )?.[1];
        return [...(list ?? "").matchAll(/"([^"]+)"/g)].map(([, topic]) => [
          topic,
          uri,
        ]);
      });

    expect(routed.sort()).toEqual([
      ["customers/data_request", "/webhooks/customers/data_request"],
      ["customers/redact", "/webhooks/customers/redact"],
      ["shop/redact", "/webhooks/shop/redact"],
    ]);
  });
});
