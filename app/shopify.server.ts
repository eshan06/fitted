import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  type Session,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// Each staff member who opens Fitted gets an online session, which names them
// in version history (ARCHITECTURE §3). Storing one deletes the shop's expired
// ones, so a staff member's name and email go once their session ends (§14).
export class SessionStorage extends PrismaSessionStorage<typeof prisma> {
  async storeSession(session: Session) {
    const stored = await super.storeSession(session);
    if (session.isOnline)
      // A failed clean-up never fails the sign-in: the next one tries again.
      await prisma.session
        .deleteMany({
          where: {
            shop: session.shop,
            isOnline: true,
            expires: { lt: new Date() },
          },
        })
        .catch((err: unknown) =>
          console.log(
            JSON.stringify({
              level: "error",
              msg: "Expired staff sessions weren't deleted",
              shop: session.shop,
              route: "session-storage",
              detail: err instanceof Error ? err.name : "unknown",
            }),
          ),
        );
    return stored;
  }
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new SessionStorage(prisma),
  // Admin calls run as the staff member; webhooks, jobs, the app proxy and the
  // plan write load the offline session instead (§3).
  useOnlineTokens: true,
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
