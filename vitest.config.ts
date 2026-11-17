import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Separate from vite.config.ts so tests don't load the React Router build plugin.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["app/**/*.test.{ts,tsx}", "extensions/**/*.test.{ts,tsx,js}"],
  },
});
