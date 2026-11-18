import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "./webhooks.app.scopes_update";

const { webhook, update } = vi.hoisted(() => ({
  webhook: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../shopify.server", () => ({ authenticate: { webhook } }));
vi.mock("../db.server", () => ({ default: { session: { update } } }));

const shop = "fitted-test.myshopify.com";
const topic = "APP_SCOPES_UPDATE";
const session = { id: `offline_${shop}`, shop, scope: "read_products" };
const payload = {
  previous: ["read_products"],
  current: ["read_products", "write_products"],
};
const webhookRequest = () =>
  new Request("https://fitted.test/webhooks/app/scopes_update", {
    method: "POST",
  });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("app/scopes_update webhook", () => {
  it("saves the current scopes on the webhook's session and returns 200", async () => {
    webhook.mockResolvedValue({ shop, session, topic, payload });
    const request = webhookRequest();

    const response = await action({ request } as ActionFunctionArgs);

    expect(webhook.mock.calls[0]?.[0]).toBe(request);
    expect(update).toHaveBeenCalledExactlyOnceWith({
      where: { id: `offline_${shop}` },
      data: { scope: "read_products,write_products" },
    });
    expect(response.status).toBe(200);
  });

  it("touches no database row and returns 200 without a session", async () => {
    webhook.mockResolvedValue({ shop, session: undefined, topic, payload });

    const response = await action({
      request: webhookRequest(),
    } as ActionFunctionArgs);

    expect(update).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("passes a failed HMAC check on to Shopify as the library's 401", async () => {
    const unauthorized = new Response(undefined, { status: 401 });
    webhook.mockRejectedValue(unauthorized);

    await expect(
      action({ request: webhookRequest() } as ActionFunctionArgs),
    ).rejects.toBe(unauthorized);
    expect(update).not.toHaveBeenCalled();
  });

  it("fails the request when the update fails, so Shopify retries", async () => {
    webhook.mockResolvedValue({ shop, session, topic, payload });
    update.mockRejectedValue(new Error("database unavailable"));

    await expect(
      action({ request: webhookRequest() } as ActionFunctionArgs),
    ).rejects.toThrow("database unavailable");
  });
});
