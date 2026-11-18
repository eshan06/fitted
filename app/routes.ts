import { flatRoutes } from "@react-router/fs-routes";

// flatRoutes makes every file in app/routes a route. Drop exactly what Vitest
// runs (vitest.config.ts), so a route misnamed as a test fails npm test.
export default flatRoutes({ ignoredRouteFiles: ["**/*.test.{ts,tsx}"] });
