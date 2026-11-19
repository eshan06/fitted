// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";

const { start } = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("./guide-loader", () => ({ start }));

it("starts the loader with import() as the way to load guide.js", async () => {
  await import("./guide-entry");
  expect(start).toHaveBeenCalledOnce();
  const load = start.mock.calls[0][0];
  await expect(load("./guide")).resolves.toHaveProperty(
    "render",
    expect.any(Function),
  );
});
