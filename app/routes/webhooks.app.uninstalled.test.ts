import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "./webhooks.app.uninstalled";

const { webhook, deleteMany } = vi.hoisted(() => ({
  webhook: vi.fn(),
  deleteMany: vi.fn(),
}));
vi.mock("../shopify.server", () => ({ authenticate: { webhook } }));
vi.mock("../db.server", () => ({ default: { session: { deleteMany } } }));

const shop = "fitted-test.myshopify.com";
const topic = "APP_UNINSTALLED";
const session = { id: `offline_${shop}`, shop };
const webhookRequest = () =>
  new Request("https://fitted.test/webhooks/app/uninstalled", {
    method: "POST",
  });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("app/uninstalled webhook", () => {
  it("deletes every session for the shop and returns 200", async () => {
    webhook.mockResolvedValue({ shop, session, topic });
    const request = webhookRequest();

    const response = await action({ request } as ActionFunctionArgs);

    expect(webhook.mock.calls[0]?.[0]).toBe(request);
    expect(deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { shop } });
    expect(response.status).toBe(200);
  });

  it("touches no database row and returns 200 once the sessions are gone", async () => {
    webhook.mockResolvedValue({ shop, session: undefined, topic });

    const response = await action({
      request: webhookRequest(),
    } as ActionFunctionArgs);

    expect(deleteMany).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("passes a failed HMAC check on to Shopify as the library's 401", async () => {
    const unauthorized = new Response(undefined, { status: 401 });
    webhook.mockRejectedValue(unauthorized);

    await expect(
      action({ request: webhookRequest() } as ActionFunctionArgs),
    ).rejects.toBe(unauthorized);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("fails the request when the delete fails, so Shopify retries", async () => {
    webhook.mockResolvedValue({ shop, session, topic });
    deleteMany.mockRejectedValue(new Error("database unavailable"));

    await expect(
      action({ request: webhookRequest() } as ActionFunctionArgs),
    ).rejects.toThrow("database unavailable");
  });
});
