import { createHmac } from "node:crypto";
import { Session } from "@shopify/shopify-app-react-router/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticate,
  sessionStorage,
  unauthenticated,
} from "./shopify.server";
import { staffName } from "./models/chart-history.server";

// The app's auth (ARCHITECTURE §3, §14) through the real library: an admin
// request runs as the staff member on their online session, background work on
// the shop's offline one, and storing a staff session deletes the shop's
// expired ones. Only the database and Shopify's token endpoint are faked.
const h = vi.hoisted(() => {
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = "test-api-secret";
  process.env.SHOPIFY_APP_URL = "https://fitted.test";
  const fetchMock = vi.fn();
  // Stubbed before the library loads: it keeps the fetch it finds then.
  vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));
  const session = {
    count: vi.fn(), // the session storage's startup check
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  };
  return { fetchMock, session };
});
vi.mock("./db.server", () => ({ default: { session: h.session } }));

const SHOP = "fitted-test.myshopify.com";
const USER = 74299867353; // past 32 bits, as Shopify's user ids are
const staff = {
  id: USER,
  first_name: "Priya",
  last_name: "Nair",
  email: "priya@example.com",
  email_verified: true,
  account_owner: false,
  locale: "en",
  collaborator: false,
};

// The session token App Bridge sends with each request, signed with the app's secret.
const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
function adminRequest() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: "test-api-key",
    sub: String(USER),
    exp: now + 60,
    nbf: now - 5,
    iat: now - 5,
    jti: "test-jti",
    sid: "test-sid",
  });
  const sig = createHmac("sha256", "test-api-secret")
    .update(`${head}.${body}`)
    .digest("base64url");
  return new Request("https://fitted.test/app", {
    headers: { Authorization: `Bearer ${head}.${body}.${sig}` },
  });
}

// A session as the database holds it, its token good for an hour.
const row = (online: boolean) => ({
  id: online ? `${SHOP}_${USER}` : `offline_${SHOP}`,
  shop: SHOP,
  state: "",
  isOnline: online,
  scope: "write_products",
  expires: new Date(Date.now() + 60 * 60_000),
  accessToken: "test-access-token",
  userId: online ? BigInt(USER) : null,
  firstName: online ? staff.first_name : null,
  lastName: online ? staff.last_name : null,
  email: online ? staff.email : null,
  accountOwner: false,
  locale: online ? staff.locale : null,
  collaborator: false,
  emailVerified: online,
  refreshToken: online ? null : "test-refresh-token",
  refreshTokenExpires: online ? null : new Date(Date.now() + 90 * 86_400_000),
});

// Shopify's token endpoint: the offline or online token the exchange asks for.
const OFFLINE = "urn:shopify:params:oauth:token-type:offline-access-token";
const ONLINE = "urn:shopify:params:oauth:token-type:online-access-token";
const asked = () =>
  h.fetchMock.mock.calls.map(
    ([, init]) => JSON.parse(String(init.body)).requested_token_type,
  );

let logs: string[];
const lines = () =>
  logs.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((l) => logs.push(String(l)));
  h.session.upsert.mockResolvedValue({});
  h.session.deleteMany.mockResolvedValue({ count: 0 });
  h.fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const token =
      JSON.parse(String(init.body)).requested_token_type === ONLINE
        ? {
            access_token: "test-online-token",
            scope: "write_products",
            expires_in: 86399,
            associated_user_scope: "write_products",
            associated_user: staff,
          }
        : {
            access_token: "test-offline-token",
            scope: "write_products",
            expires_in: 3600,
            refresh_token: "test-refresh-token",
            refresh_token_expires_in: 7776000,
          };
    return new Response(JSON.stringify(token), {
      headers: { "Content-Type": "application/json" },
    });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("signing in to Fitted's admin (§3)", () => {
  it("runs an admin request as the staff member, whose session names them", async () => {
    h.session.findUnique.mockResolvedValue(row(true));

    const { session } = await authenticate.admin(adminRequest());

    expect(h.session.findUnique).toHaveBeenCalledWith({
      where: { id: `${SHOP}_${USER}` },
    });
    expect(session.isOnline).toBe(true);
    expect(staffName(session)).toBe("Priya N.");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("gets the staff member's token when none is stored, deleting the shop's expired staff sessions (§14)", async () => {
    h.session.findUnique.mockResolvedValue(null);

    const { session } = await authenticate.admin(adminRequest());

    expect(asked()).toEqual([OFFLINE, ONLINE]);
    expect(h.session.upsert.mock.calls.map(([q]) => q.where.id)).toEqual([
      `offline_${SHOP}`,
      `${SHOP}_${USER}`,
    ]);
    expect(session.id).toBe(`${SHOP}_${USER}`);
    expect(staffName(session)).toBe("Priya N.");
    // Only after the staff session, never the offline one, and only this shop's.
    expect(h.session.deleteMany).toHaveBeenCalledTimes(1);
    expect(h.session.deleteMany).toHaveBeenCalledWith({
      where: { shop: SHOP, isOnline: true, expires: { lt: expect.any(Date) } },
    });
    expect(h.session.deleteMany.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.session.upsert.mock.invocationCallOrder[1],
    );
  });

  it("runs background work on the shop's offline session", async () => {
    h.session.findUnique.mockResolvedValue(row(false));

    const { session } = await unauthenticated.admin(SHOP);

    expect(h.session.findUnique).toHaveBeenCalledWith({
      where: { id: `offline_${SHOP}` },
    });
    expect(session.isOnline).toBe(false);
  });

  it("still stores a staff session when the clean-up fails, logging it without their name", async () => {
    h.session.deleteMany.mockRejectedValue(
      new Error("connection lost for priya@example.com"),
    );
    const priya = new Session({
      id: `${SHOP}_${USER}`,
      shop: SHOP,
      state: "",
      isOnline: true,
      accessToken: "test-online-token",
      expires: new Date(Date.now() + 60 * 60_000),
      onlineAccessInfo: {
        expires_in: 3599,
        associated_user_scope: "write_products",
        associated_user: staff,
      },
    });

    expect(await sessionStorage.storeSession(priya)).toBe(true);

    expect(lines()).toEqual([
      {
        level: "error",
        msg: "Expired staff sessions weren't deleted",
        shop: SHOP,
        route: "session-storage",
        detail: "Error",
      },
    ]);
    expect(logs.join("\n")).not.toMatch(/Priya|priya@/);
  });
});
