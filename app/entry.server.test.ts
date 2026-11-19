import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ startJobChecks: vi.fn() }));
vi.mock("./models/rules.server", () => ({ startJobChecks: h.startJobChecks }));
vi.mock("./shopify.server", () => ({ addDocumentResponseHeaders: vi.fn() }));

// The job checks start with the server, before any request (ARCHITECTURE §13).
it("starts the job checks when the server loads", async () => {
  await import("./entry.server");

  expect(h.startJobChecks).toHaveBeenCalledOnce();
});
