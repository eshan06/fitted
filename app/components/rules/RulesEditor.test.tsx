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
const edit = (
  rules: Rules,
  digest: string | null = "d1",
  damaged: string[] | null = null,
  more = {},
) => ({
  mode: "edit",
  charts,
  rules,
  digest,
  damaged,
  job: null,
  products: 340,
  counts: null,
  names: {},
  free: false,
  plansUrl: null,
  ...more,
});
const PLANS =
  "https://admin.shopify.com/store/s/charges/fitted-5/pricing_plans";
const job = (status: string, at: number, error: string | null = null) => ({
  status,
  error,
  at,
  merchant: true,
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
  vi.useRealTimers();
});

// Renders the route with a loader and an action that answer in turn.
// The screen's polls get `polls` in turn, then the last one again; its
// matches card gets each chart's entry in `previews`, else none.
async function open(
  loaded: unknown[],
  answers: { status: number; body: unknown }[] = [],
  polls: unknown[] = [],
  previews: Record<string, unknown> = {},
) {
  const sent: Record<string, unknown>[] = [];
  let n = 0;
  const poll = vi.fn(() => ({
    job: polls.length > 1 ? polls.shift() : polls[0],
  }));
  const loader = vi.fn(({ request }: { request: Request }) => {
    const q = new URL(request.url).searchParams;
    if (q.has("preview"))
      return { mode: "preview", preview: previews[q.get("preview")!] ?? null };
    return q.has("job") ? poll() : loaded[Math.min(n++, loaded.length - 1)];
  });
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
  return { sent, loader, poll };
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

  it("on Free, marks the paid fields and opens the chart whose condition the plan refused, with the plans page", async () => {
    const tagged = ranked();
    tagged.charts[A].match = [{ field: "tag", op: "is", value: "women-top" }];
    const fieldErrors = {
      [`charts.${A}.match.0`]:
        "Tag, type, vendor and metafield rules are on Standard and Pro",
    };
    await open(
      [edit(tagged, "d1", null, { free: true, plansUrl: PLANS })],
      [
        {
          status: 403,
          body: {
            error: { code: "plan", message: "x" },
            fieldErrors,
            checkFailed: true,
            plansUrl: PLANS,
          },
        },
      ],
    );
    expect(
      (byLabel("Field") as unknown as HTMLSelectElement).selectedOptions[0]
        .textContent,
    ).toBe("Tag (Standard)");
    expect(text()).toContain(
      "On Free, new conditions can use Collection or Specific products. The others need Standard.",
    );
    expect(document.querySelector(`.help a[href="${PLANS}"]`)).not.toBeNull();
    await type(byLabel("Value"), "women-tops");
    await click(buttons("2. Shoes")[0]);
    await click(buttons("Save")[0]);
    expect(document.querySelector("h2")?.textContent).toBe("Women's tops");
    expect(headings()).toEqual(["This change needs the Standard plan"]);
    expect(text()).toContain(
      "Couldn't check your plan, so Fitted uses the last one it confirmed, Free.On Free, tag, product type, vendor and metafield conditions keep working but can't be added or changed, so nothing was saved.Change the tag condition back or remove it, or move to Standard, $9 a month.",
    );
    expect(text()).toContain(
      "Was women-top. On Free, change it back or remove it.",
    );
    expect(buttons("See plans")[0].getAttribute("href")).toBe(PLANS);
    const field = document.getElementById("r1-match-0-field")!;
    expect(field.className).toContain("bad");
    await click(buttons("2. Shoes")[0]);
    await click(document.querySelector<HTMLElement>("s-banner a")!);
    expect(document.querySelector("h2")?.textContent).toBe("Women's tops");
    await settle();
    expect(document.activeElement).toBe(
      document.getElementById("r1-match-0-field"),
    );
  });

  // Review round 1: "Was" named the saved condition at the same position.
  it("on Free, says what a refused condition was only when it was edited in place", async () => {
    const tagged = ranked();
    tagged.charts[A].match = [
      { field: "tag", op: "is", value: "a" },
      { field: "tag", op: "is", value: "b" },
    ];
    const refuse = {
      status: 403,
      body: {
        error: { code: "plan", message: "x" },
        fieldErrors: { [`charts.${A}.match.0`]: "On Standard and Pro" },
      },
    };
    await open([edit(tagged, "d1", null, { free: true })], [refuse]);
    await click(byLabel("Remove condition"));
    await type(byLabel("Value"), "c");
    await click(buttons("Save")[0]);
    expect(text()).toContain("On Free, change it back or remove it.");
    expect(text()).not.toContain("Was ");
  });

  it("lists each problem in the Fix banner, linking it to its field, another chart's by name", async () => {
    await open([edit(ranked())]);
    await click(buttons("Add condition")[1]);
    await type(byLabel("Field", 1), "tag");
    await click(buttons("2. Shoes")[0]);
    await click(buttons("Add condition")[0]);
    await type(byLabel("Field", 1), "metafield");
    await type(byLabel("Metafield key"), "app--4821.fit");
    await type(byLabel("Value", 0), "x".repeat(256));
    await click(buttons("Save")[0]);
    // Two of the problems are one condition's.
    expect(headings()).toEqual(["Fix 2 conditions to save"]);
    const items = [...document.querySelectorAll("s-banner li")].map(
      (li) => li.textContent,
    );
    expect(items).toEqual([
      "Never show it on: Tag has no value",
      "Shoes: Metafield belongs to an app, so rules can't use it",
      "Shoes: Metafield is longer than 255 characters",
    ]);
  });

  it("reorders by dragging a chart onto another's place", async () => {
    const { sent } = await open([edit(ranked())]);
    const [first, second] = document.querySelectorAll(".ranks li");
    await act(async () => {
      first.dispatchEvent(new Event("dragstart", { bubbles: true }));
    });
    await act(async () => {
      second.dispatchEvent(new Event("drop", { bubbles: true }));
    });
    expect(buttons("1. Shoes")).toHaveLength(1);
    // A later drop with nothing dragged moves nothing.
    await act(async () => {
      second.dispatchEvent(new Event("drop", { bubbles: true }));
    });
    expect(buttons("1. Shoes")).toHaveLength(1);
    await click(buttons("Save")[0]);
    expect((sent[0].rules as Rules).order).toEqual([B, A]);
  });

  it("edits a metafield condition's key and comparison", async () => {
    const { sent } = await open([edit(ranked())]);
    await click(buttons("Add condition")[0]);
    await type(byLabel("Field", 1), "metafield");
    await type(byLabel("Metafield key"), "custom.fit");
    await type(byLabel("Condition", 1), "contains");
    await type(byLabel("Value"), "slim");
    await click(buttons("Save")[0]);
    expect((sent[0].rules as Rules).charts[A].match[1]).toEqual({
      field: "metafield",
      key: "custom.fit",
      op: "contains",
      value: "slim",
    });
  });

  it("keeps the edits and the banner's place when a conflict is cancelled", async () => {
    await open(
      [edit(ranked())],
      [{ status: 409, body: { error: { code: "conflict", message: "x" } } }],
    );
    await act(async () =>
      byLabel("Move Women's tops").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    await click(buttons("Save")[0]);
    await click(buttons("Cancel")[0]);
    expect(headings()).toEqual([]);
    expect(buttons("1. Shoes")).toHaveLength(1);
    expect(saveBar()).not.toBeNull();
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

  it("names each problem in saved rules that fail the checks, and sets them up again blank", async () => {
    const lines = ["Women's tops: a tag condition has no value"];
    const { sent } = await open([edit(none(), "d0", lines)]);
    expect(headings()).toEqual(["Your saved display rules couldn't be read"]);
    expect(document.querySelector("s-banner li")?.textContent).toBe(lines[0]);
    expect(text()).toContain("Not sure what changed them? Email");
    expect(buttons("Add condition")).toEqual([]);
    await click(buttons("Set up rules again")[0]);
    expect(headings()).toEqual([]);
    // Empty rules replace them too, so the save bar opens with no edit.
    expect(saveBar()).not.toBeNull();
    await click(buttons("Discard")[0]);
    expect(headings()).toEqual(["Your saved display rules couldn't be read"]);
    await click(buttons("Set up rules again")[0]);
    await click(buttons("Save")[0]);
    expect(sent).toEqual([{ rules: none(), digest: "d0" }]);
  });

  it("shows the rules applying after a save until a newer resolve ends, then that it didn't finish, and tries again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { sent, poll } = await open(
      [edit(ranked(), "d1", null, { job: job("done", 5) })],
      [{ status: 200, body: { ok: true, after: 5 } }],
      [
        job("done", 5),
        job("running", 9),
        job("failed", 9, "Shopify request failed"),
      ],
    );
    await act(async () =>
      byLabel("Move Women's tops").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    await click(buttons("Save")[0]);
    expect(headings()).toEqual(["Applying your rules to 340 products"]);
    for (let i = 0; i < 3; i++)
      await act(async () => vi.advanceTimersByTime(3000));
    await settle();
    expect(poll).toHaveBeenCalledTimes(3);
    expect(headings()).toEqual(["Your rules didn't finish applying"]);
    expect(text()).toContain(
      "They're saved, but Shopify stopped responding, so some products still show their old chart. Fitted tries again within a few minutes.",
    );
    await act(async () => vi.advanceTimersByTime(6000));
    expect(poll).toHaveBeenCalledTimes(3);
    await click(buttons("Try again")[0]);
    expect(sent[1]).toEqual({ intent: "apply" });
  });

  it("shows a merchant's running resolve as applying, but not the daily check's", async () => {
    await open([
      edit(ranked(), "d1", null, { job: job("running", 5), products: null }),
    ]);
    expect(headings()).toEqual(["Applying your rules to your products"]);
    act(() => root?.unmount());
    root = undefined;
    await open([
      edit(ranked(), "d1", null, {
        job: { ...job("running", 5), merchant: false },
      }),
    ]);
    expect(headings()).toEqual([]);
  });

  it("words the job's own reason, and says when Try again is refused", async () => {
    await open(
      [
        edit(ranked(), "d1", null, {
          job: job("failed", 5, "Shopify refused the chart for 3 products"),
        }),
      ],
      [
        { status: 403, body: { error: { code: "product_access" } } },
        { status: 502, body: { error: { code: "shopify" } } },
      ],
    );
    expect(text()).toContain(
      "They're saved, but Shopify refused the chart for 3 products, so",
    );
    await click(buttons("Try again")[0]);
    expect(bridge.toast.show).toHaveBeenCalledWith(
      "You need Products access to apply rules. Ask the store owner to add it in Settings › Users.",
      { isError: true },
    );
    expect(headings()).toEqual(["Your rules didn't finish applying"]);
    await click(buttons("Try again")[0]);
    expect(bridge.toast.show).toHaveBeenLastCalledWith(
      "Shopify didn't respond, so the rules weren't applied. Try again.",
      { isError: true },
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
    const pages = loader.mock.calls.filter(
      ([a]) => !a.request.url.includes("preview"),
    );
    expect(pages).toHaveLength(2);
    expect(document.querySelector("h2")?.textContent).toBe("Women's tops");
  });
});

const matches = () =>
  document.querySelector('[aria-label="Matching products"]');
const ids = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `gid://shopify/Product/${i + from}`);
const metafields = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    field: "metafield" as const,
    key: `custom.k${i}`,
    op: "is" as const,
    value: "x",
  }));

describe("matches, counts and names", () => {
  it("previews the chart on screen's products, and each chart's count in the list", async () => {
    const top = {
      count: 148,
      atLeast: false,
      products: [
        { id: P, title: "Linen wrap top", image: "https://cdn/1" },
        { id: "p2", title: "Ribbed tank", image: null },
      ],
      url: "https://admin.shopify.com/store/s/products?query=q",
    };
    const shoes = { count: 0, atLeast: false, products: [], url: "u" };
    const counts = { [A]: { count: 148, atLeast: false } };
    await open([edit(ranked(), "d1", null, { counts })], [], [], {
      [A]: top,
      [B]: shoes,
    });
    expect(matches()?.querySelector("h2")?.textContent).toBe(
      "148 products match",
    );
    expect(matches()?.textContent).toContain("Linen wrap topRibbed tank");
    expect(matches()?.querySelector("img")?.getAttribute("src")).toBe(
      "https://cdn/1",
    );
    const all = matches()?.querySelector("a");
    expect(all?.textContent).toBe("See all 148");
    expect(all?.getAttribute("href")).toBe(top.url);
    expect(all?.getAttribute("target")).toBe("_blank");
    const list = document.querySelector("ol")!.textContent;
    expect(list).toContain("1. Women's tops148 products");
    expect(list).toContain("2. ShoesEverything else");
    await click(buttons("2. Shoes")[0]);
    expect(matches()?.textContent).toBe("0 products match");
  });

  it("leaves the matches card out when Shopify gives no preview", async () => {
    await open([edit(ranked())]);
    expect(matches()).toBeNull();
    expect(document.querySelector("h2")?.textContent).toBe("Women's tops");
  });

  it("names picked products, the loaded ones and the ones just picked", async () => {
    const Q = "gid://shopify/Product/10";
    bridge.resourcePicker.mockResolvedValue([
      { id: P, title: "Linen wrap top" },
      { id: Q, title: "Silk camisole" },
    ]);
    await open([edit(ranked(), "d1", null, { names: { [P]: "Linen wrap" } })]);
    expect(document.querySelector(".picked")?.textContent).toContain(
      "Linen wrap",
    );
    await click(byLabel("Edit the picked products"));
    expect(document.querySelector(".picked")?.textContent).toContain(
      "Linen wrap top, Silk camisole",
    );
  });
});

describe("the three limits", () => {
  it("marks the 21st metafield and saves nothing", async () => {
    const r = ranked();
    r.charts[A].match = metafields(20);
    const { sent } = await open([edit(r)]);
    await click(buttons("Add condition")[0]);
    await type(byLabel("Field", 20), "metafield");
    await type(byLabel("Metafield key", 20), "custom.sleeve_length");
    await type(byLabel("Value", 20), "long");
    await click(buttons("Save")[0]);
    expect(sent).toEqual([]);
    expect(headings()).toEqual(["20 of 20 metafields in use"]);
    expect(text()).toContain(
      "That's the most rules can compare, so the marked condition can't be saved. Use a metafield your rules already compare, or a tag, product type or vendor.",
    );
    expect(text()).toContain(
      "This would be the 21st metafield. The most is 20.",
    );
    const key = document.getElementById("r1-match-20-key")!;
    expect(key.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(key);
    // A key the rules already compare doesn't count.
    await type(key as HTMLInputElement, "custom.k3");
    await click(buttons("Save")[0]);
    expect(sent).toHaveLength(1);
  });

  it("marks the condition whose picks go past 1,000 and saves nothing", async () => {
    const r = ranked();
    r.charts[A].match = [{ field: "product", op: "is", ids: ids(990) }];
    bridge.resourcePicker.mockResolvedValue(
      ids(38, 2000).map((id) => ({ id })),
    );
    const { sent } = await open([edit(r)]);
    await click(buttons("Add condition")[1]);
    await type(byLabel("Field", 1), "product");
    await click(byLabel("Edit the picked products", 1));
    await click(buttons("Save")[0]);
    expect(sent).toEqual([]);
    expect(headings()).toEqual([
      "1,028 of 1,000 products and collections picked",
    ]);
    expect(text()).toContain(
      "The marked condition goes over, so it can't be saved. Use a tag (doesn't count) or a whole collection (counts once) instead.",
    );
    expect(text()).toContain(
      "38 products picked here, 1,028 across all your charts. The most is 1,000.",
    );
    expect(document.activeElement?.id).toBe("r1-exclude-0-value");
    expect(document.querySelectorAll(".picked")[1].className).toContain("bad");
  });

  it("at 200 ranked charts, shortens the list and lets a chart come off it", async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      id: `gid://shopify/Metaobject/${i + 1}`,
      name: `Chart ${i + 1}`,
    }));
    const r: Rules = { v: 1, order: [], charts: {} };
    for (const c of many.slice(0, 200)) {
      r.order.push(c.id);
      r.charts[c.id] = { match: [{ field: "all" }], exclude: [], auto: true };
    }
    const { sent } = await open([edit(r, "d1", null, { charts: many })]);
    expect(headings()).toEqual(["200 of 200 charts ranked"]);
    expect(text()).toContain(
      "That's the most rules can rank. To add rules to another chart, take one you don't use off the list below.",
    );
    expect(text()).toContain("200 of 200 ranked");
    expect(document.querySelectorAll("ol li")).toHaveLength(10);
    expect(text()).not.toContain("Add rules to another chart");
    expect(text()).toContain(
      "Taking a chart off the list removes its rules. The chart itself stays.",
    );
    await click(buttons("Show all 200")[0]);
    expect(document.querySelectorAll("ol li")).toHaveLength(200);
    expect(buttons("Show all 200")).toHaveLength(0);
    await click(byLabel("Take Chart 2 off the list"));
    expect(headings()).toEqual([]);
    expect(document.querySelectorAll("ol li")).toHaveLength(199);
    expect(text()).toContain("Add rules to another chart");
    await click(buttons("Save")[0]);
    const saved = sent[0].rules as Rules;
    expect(saved.order).toHaveLength(199);
    expect(saved.order).not.toContain("gid://shopify/Metaobject/2");
    expect(saved.charts).not.toHaveProperty("gid://shopify/Metaobject/2");
  });
});
