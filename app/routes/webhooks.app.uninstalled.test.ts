import { createHmac } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPlan } from "../models/billing.server";
import { action } from "./webhooks.app.uninstalled";

// app/uninstalled (ARCHITECTURE §16) through the real authenticate.webhook, so
// every delivery's signature is checked with the app's secret, and the library
// loads the shop's offline session and refreshes its token as it would in
// production. Only the database and the network are mocked.
const { db, secret, fetchMock } = vi.hoisted(() => {
  const secret = "test-api-secret";
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = secret;
  process.env.SHOPIFY_APP_URL = "https://fitted.test";
  const fetchMock = vi.fn();
  // Stubbed before the library loads: it keeps the fetch it finds then.
  vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));
  const db = {
    // `count` is the session storage's startup check.
    session: { count: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
    shop: { findUnique: vi.fn(), updateMany: vi.fn() },
  };
  return { db, secret, fetchMock };
});
vi.mock("../db.server", () => ({ default: db }));

const shop = "fitted-test.myshopify.com";
const body = JSON.stringify({ id: 548380009, domain: shop }); // part of Shopify's sample

/** Answers as the route would: a Response the library throws is the reply. */
const deliver = ({ signedWith = secret, signed = true } = {}) => {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Shopify-Topic": "app/uninstalled",
    "X-Shopify-Shop-Domain": shop,
    "X-Shopify-API-Version": "2026-07",
    "X-Shopify-Webhook-Id": "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
  });
  if (signed) {
    const hmac = createHmac("sha256", signedWith).update(body).digest("base64");
    headers.set("X-Shopify-Hmac-Sha256", hmac);
  }
  const request = new Request("https://fitted.test/webhooks/app/uninstalled", {
    method: "POST",
    headers,
    body,
  });
  return action({ request } as ActionFunctionArgs).catch((thrown: unknown) => {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  });
};

/** The shop's offline session as the database holds it. */
const storedSession = (tokenExpiresInMinutes: number) => ({
  id: `offline_${shop}`,
  shop,
  state: "",
  isOnline: false,
  scope: "write_products",
  expires: new Date(Date.now() + tokenExpiresInMinutes * 60_000),
  accessToken: "test-access-token",
  userId: null,
  firstName: null,
  lastName: null,
  email: null,
  accountOwner: false,
  locale: null,
  collaborator: false,
  emailVerified: false,
  refreshToken: "test-refresh-token",
  refreshTokenExpires: new Date(Date.now() + 90 * 86_400_000),
});
// Shopify's answer to every refresh it won't take, an uninstalled app's included
// (shopify.dev, "Refresh an expiring offline token").
const refreshRefused = () =>
  new Response(
    JSON.stringify({
      error: "invalid_request",
      error_description: "This request requires an active refresh_token",
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
const deleteSessions = { where: { shop } };
const resetPlanToFree = {
  where: { shop },
  data: { plan: "free", planCheckedAt: null, planOnStore: null },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("app/uninstalled webhook", () => {
  it.each([
    ["signed with another secret", { signedWith: "not-the-app-secret" }, 401],
    ["unsigned", { signed: false }, 400],
  ])(
    "refuses a delivery %s, before any query or call to Shopify",
    async (_, options, status) => {
      expect((await deliver(options)).status).toBe(status);

      for (const query of [
        ...Object.values(db.session),
        ...Object.values(db.shop),
      ]) {
        expect(query).not.toHaveBeenCalled();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("deletes the shop's sessions, resets its cached plan to Free and returns 200", async () => {
    db.session.findUnique.mockResolvedValue(storedSession(60));

    expect((await deliver()).status).toBe(200);

    expect(db.session.deleteMany).toHaveBeenCalledExactlyOnceWith(
      deleteSessions,
    );
    expect(db.shop.updateMany).toHaveBeenCalledExactlyOnceWith(resetPlanToFree);
  });

  it("deletes the sessions when Shopify refuses to refresh the stored token, as it does after an uninstall", async () => {
    db.session.findUnique.mockResolvedValue(storedSession(-1));
    fetchMock.mockImplementation(refreshRefused);

    expect((await deliver()).status).toBe(200);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `https://${shop}/admin/oauth/access_token`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(db.session.deleteMany).toHaveBeenCalledExactlyOnceWith(
      deleteSessions,
    );
    expect(db.shop.updateMany).toHaveBeenCalledExactlyOnceWith(resetPlanToFree);
  });

  it("does both again and returns 200 when Shopify repeats the delivery after the sessions are gone", async () => {
    db.session.findUnique.mockResolvedValue(null);

    expect((await deliver()).status).toBe(200);

    expect(db.session.deleteMany).toHaveBeenCalledExactlyOnceWith(
      deleteSessions,
    );
    expect(db.shop.updateMany).toHaveBeenCalledExactlyOnceWith(resetPlanToFree);
  });

  it.each([
    ["deleting the sessions", db.session.deleteMany],
    ["resetting the plan", db.shop.updateMany],
  ])(
    "fails the request when %s fails, so Shopify retries",
    async (_, query) => {
      query.mockRejectedValue(new Error("database unavailable"));

      await expect(deliver()).rejects.toThrow("database unavailable");
    },
  );

  it("leaves a confirmed Pro plan reading as Free when the next plan check fails", async () => {
    // A Pro plan confirmed a minute ago, as billing.server.ts caches it (§8).
    let cached = {
      shop,
      plan: "pro",
      planCheckedAt: new Date(Date.now() - 60_000),
      planOnStore: "pro",
      resolvedAt: null,
    };
    db.shop.findUnique.mockImplementation(async () => cached);
    db.shop.updateMany.mockImplementation(async ({ data }) => {
      cached = { ...cached, ...data };
    });
    let session: object | null = storedSession(-1);
    db.session.findUnique.mockImplementation(async () => session);
    db.session.deleteMany.mockImplementation(async () => {
      session = null;
    });
    fetchMock.mockImplementation(refreshRefused);
    await expect(getPlan(shop)).resolves.toEqual({
      plan: "pro",
      checkFailed: false,
    });

    expect((await deliver()).status).toBe(200);

    // Fitted holds no token for the shop now, so the check fails. A reinstall's
    // first check that fails for any other reason ends the same way.
    await expect(getPlan(shop)).resolves.toEqual({
      plan: "free",
      checkFailed: true,
    });
  });
});
