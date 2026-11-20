// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Rules } from "../../models/rules.server";

// The route's server half needs Shopify and the database; the screen doesn't.
vi.mock("../../shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../../db.server", () => ({ default: {} }));
const bridge = vi.hoisted(() => ({
  resourcePicker: vi.fn(),
  toast: { show: vi.fn() },
}));
// The save bar is App Bridge's; here it renders its buttons in place.
vi.mock("@shopify/app-bridge-react", () => ({
  SaveBar: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="save-bar">{children}</div> : null,
  useAppBridge: () => bridge,
}));
const { default: DisplayRules } = await import("../../routes/app.rules");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const A = "gid://shopify/Metaobject/1";
const B = "gid://shopify/Metaobject/2";
const P = "gid://shopify/Product/9";
const charts = [
  { id: A, name: "Women's tops" },
  { id: B, name: "Shoes" },
];
const edit = (rules: Rules, digest: string | null = "d1", damaged = null) => ({
  mode: "edit",
  charts,
  rules,
  digest,
  damaged,
});
const none = (): Rules => ({ v: 1, order: [], charts: {} });
const ranked = (): Rules => ({
  v: 1,
  order: [A, B],
  charts: {
    [A]: {
      match: [{ field: "product", op: "is", ids: [P] }],
      exclude: [],
      auto: true,
    },
    [B]: { match: [{ field: "all" }], exclude: [], auto: false },
  },
});

let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

// Renders the route with a loader and an action that answer in turn.
async function open(
  loaded: unknown[],
  answers: { status: number; body: unknown }[] = [],
) {
  const sent: Record<string, unknown>[] = [];
  const loader = vi.fn(
    () => loaded[Math.min(loader.mock.calls.length - 1, loaded.length - 1)],
  );
  const Stub = createRoutesStub([
    {
      path: "/app/rules",
      Component: DisplayRules,
      HydrateFallback: () => null,
      loader,
      action: async ({ request }) => {
        sent.push(await request.json());
        const a = answers.shift() ?? { status: 200, body: { ok: true } };
        return Response.json(a.body, { status: a.status });
      },
    },
  ]);
  const div = document.body.appendChild(document.createElement("div"));
  root = createRoot(div);
  await act(async () => root!.render(<Stub initialEntries={["/app/rules"]} />));
  await settle();
  return { sent, loader };
}
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const text = () => document.body.textContent ?? "";
const headings = () =>
  [...document.querySelectorAll("s-banner")].map((b) =>
    b.getAttribute("heading"),
  );
const all = (label: string) => [
  ...document.querySelectorAll<HTMLElement>(
    `[aria-label="${label}"], [accessibilitylabel="${label}"]`,
  ),
];
const byLabel = (label: string, i = 0) => all(label)[i] as HTMLInputElement;
const buttons = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("button, s-button")].filter(
    (b) => b.textContent === label,
  );
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await settle();
};
async function type(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(
      new Event(el.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
const saveBar = () => document.querySelector('[data-testid="save-bar"]');

describe("display rules screen", () => {
  it("picks products for the first chart and saves the rules over the loaded digest", async () => {
    bridge.resourcePicker.mockResolvedValue([{ id: P }]);
    const { sent } = await open([edit(none(), null)]);
    expect(document.querySelector("h2")?.textContent).toBe("Women's tops");
    expect(saveBar()).toBeNull();
    await click(buttons("Add condition")[0]);
    await type(byLabel("Field"), "product");
    expect(text()).toContain("None picked yet");
    await click(byLabel("Edit the picked products"));
    expect(bridge.resourcePicker).toHaveBeenCalledWith({
      type: "product",
      action: "select",
      multiple: true,
      selectionIds: [],
    });
    expect(text()).toContain("1 product");
    await click(buttons("Save")[0]);
    expect(sent).toEqual([
      {
        rules: {
          v: 1,
          order: [A],
          charts: {
            [A]: {
              match: [{ field: "product", op: "is", ids: [P] }],
              exclude: [],
              auto: true,
            },
          },
        },
        digest: null,
      },
    ]);
  });

  it("marks a condition with no value, focuses it and saves nothing", async () => {
    const { sent } = await open([edit(ranked())]);
    await click(buttons("Add condition")[1]);
    await type(byLabel("Field", 1), "tag");
    await click(buttons("Save")[0]);
    expect(sent).toEqual([]);
    expect(headings()).toEqual(["Fix 1 condition to save"]);
    expect(text()).toContain(
      "Nothing was saved, so products still show the same charts.",
    );
    expect(text()).toContain("Enter a tag, like women-top.");
    const value = document.getElementById("r1-exclude-0-value")!;
    expect(value.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(value);
    await type(value as HTMLInputElement, "one-size");
    await click(buttons("Save")[0]);
    expect(sent).toHaveLength(1);
  });

  it("opens a chart from the list, reorders by keyboard and turns off new products", async () => {
    const { sent } = await open([edit(ranked())]);
    await click(buttons("2. Shoes")[0]);
    expect(document.querySelector("h2")?.textContent).toBe("Shoes");
    expect(text()).toContain("Everything else");
    await act(async () =>
      byLabel("Move Women's tops").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(buttons("1. Shoes")).toHaveLength(1);
    await click(document.querySelector<HTMLInputElement>(".check input")!);
    await click(buttons("Save")[0]);
    const saved = sent[0].rules as Rules;
    expect(saved.order).toEqual([B, A]);
    expect(saved.charts[B].auto).toBe(true);
  });

  it("adds rules to a chart that has none yet, and Discard puts things back", async () => {
    await open([
      edit({ ...ranked(), order: [A], charts: { [A]: ranked().charts[A] } }),
    ]);
    await type(document.querySelector<HTMLSelectElement>("label select")!, B);
    expect(document.querySelector("h2")?.textContent).toBe("Shoes");
    expect(saveBar()).toBeNull();
    await click(buttons("Add condition")[0]);
    expect(saveBar()).not.toBeNull();
    await click(byLabel("Remove condition"));
    expect(saveBar()).toBeNull();
    await click(buttons("Add condition")[0]);
    await click(buttons("Discard")[0]);
    expect(saveBar()).toBeNull();
  });

  it("reloads the newest rules after a conflict, discarding the edits", async () => {
    const newer = ranked();
    newer.order = [B, A];
    const { loader } = await open(
      [edit(ranked()), edit(newer, "d2")],
      [{ status: 409, body: { error: { code: "conflict" } } }],
    );
    await act(async () =>
      byLabel("Move Women's tops").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    await click(buttons("Save")[0]);
    expect(headings()).toEqual(["Display rules changed since you opened them"]);
    await click(buttons("Reload latest")[0]);
    expect(loader.mock.calls.length).toBeGreaterThan(1);
    expect(headings()).toEqual([]);
    expect(buttons("1. Shoes")).toHaveLength(1);
    expect(saveBar()).toBeNull();
  });

  it("keeps the edits when Shopify fails and tries again", async () => {
    const { sent } = await open(
      [edit(ranked())],
      [{ status: 502, body: { error: { code: "shopify" } } }],
    );
    await click(buttons("Add condition")[0]);
    bridge.resourcePicker.mockResolvedValue([
      { id: "gid://shopify/Collection/3" },
    ]);
    await click(byLabel("Edit the picked collections"));
    await click(buttons("Save")[0]);
    expect(headings()).toEqual(["Your rule changes weren't saved"]);
    expect(text()).toContain(
      "Shopify didn't respond in time, so products still show the charts they did before. Your edits are still here.",
    );
    await click(buttons("Try saving again")[0]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it("tells staff without Products access why nothing was saved", async () => {
    await open(
      [edit(ranked())],
      [{ status: 403, body: { error: { code: "product_access" } } }],
    );
    await click(buttons("Add condition")[0]);
    bridge.resourcePicker.mockResolvedValue([
      { id: "gid://shopify/Collection/3" },
    ]);
    await click(byLabel("Edit the picked collections"));
    await click(buttons("Save")[0]);
    expect(headings()).toEqual(["You need Products access to save rules"]);
    expect(text()).toContain(
      "Ask the store owner to add Products access to your account in Settings › Users.",
    );
  });

  // Seen on the dev store: the marks stayed after their condition was removed.
  it("drops the marks once a condition is added or removed, since they'd point at the wrong rows", async () => {
    await open([edit(ranked())]);
    await click(buttons("Add condition")[1]);
    await type(byLabel("Field", 1), "tag");
    await click(buttons("Save")[0]);
    expect(headings()).toEqual(["Fix 1 condition to save"]);
    await click(byLabel("Remove condition", 1));
    expect(headings()).toEqual([]);
    expect(document.querySelector(".bad")).toBeNull();
  });

  it("offers only the other charts to add rules to", async () => {
    await open([edit(none())]);
    const options = [
      ...document.querySelectorAll<HTMLOptionElement>("label select option"),
    ].map((o) => o.textContent);
    expect(options).toEqual(["Pick a chart", "Shoes"]);
  });

  it("marks the conditions the plan can't add, and the document-wide limits", async () => {
    await open(
      [edit(ranked())],
      [
        {
          status: 403,
          body: {
            fieldErrors: {
              [`charts.${A}.match.0`]:
                "Tag, type, vendor and metafield rules are on Standard and Pro",
              "": "Rules can compare at most 20 different metafields",
            },
          },
        },
      ],
    );
    await click(buttons("Add condition")[1]);
    await type(byLabel("Field", 1), "collection");
    bridge.resourcePicker.mockResolvedValue([
      { id: "gid://shopify/Collection/3" },
    ]);
    await click(byLabel("Edit the picked collections"));
    await click(buttons("Save")[0]);
    expect(headings()).toEqual(["Fix 2 conditions to save"]);
    expect(text()).toContain(
      "Rules can compare at most 20 different metafields",
    );
    expect(text()).toContain(
      "Tag, type, vendor and metafield rules are on Standard and Pro",
    );
    expect(document.getElementById("r1-match-0-field")?.className).toContain(
      "bad",
    );
  });

  it("says when the picker doesn't open", async () => {
    bridge.resourcePicker.mockRejectedValue(new Error("closed"));
    await open([edit(ranked())]);
    await click(byLabel("Edit the picked products"));
    expect(bridge.toast.show).toHaveBeenCalledWith(
      "The picker didn't open. Try again.",
      { isError: true },
    );
  });

  it("says saved rules that fail the checks are replaced by the next save", async () => {
    await open([
      edit(none(), "d0", { [`charts.${A}.match.0.value`]: "Bad" } as never),
    ]);
    expect(headings()).toEqual(["Your saved display rules couldn't be read"]);
    expect(text()).toContain(
      "Set up your rules again and save to replace them.",
    );
  });

  it("points a store with no charts at making one", async () => {
    await open([{ mode: "empty" }]);
    expect(text()).toContain("Rules need a chart to point at");
    expect(
      document.querySelector('a[href="/app/charts/new"]')?.textContent,
    ).toBe("Create chart");
    expect(document.querySelector('a[href="/app/import"]')).not.toBeNull();
  });

  it("says the rules didn't load and tries again", async () => {
    const { loader } = await open([{ mode: "error" }, edit(ranked())]);
    expect(headings()).toEqual(["Your display rules didn't load"]);
    expect(text()).toContain("Still not working? Email");
    await click(buttons("Try again")[0]);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(document.querySelector("h2")?.textContent).toBe("Women's tops");
  });
});
