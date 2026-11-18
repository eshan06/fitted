import { flatRoutes } from "@react-router/fs-routes";

// flatRoutes makes every file in app/routes a route; keep colocated tests out.
export default flatRoutes({ ignoredRouteFiles: ["**/*.test.*"] });
