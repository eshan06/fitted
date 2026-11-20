// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, type Settings } from "../models/settings.server";
import { fileSize, fontType } from "../lib/font-file";

const m = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("../shopify.server", () => ({
  authenticate: { admin: m.authenticate },
}));
vi.mock("../db.server", () => ({ default: {} }));
// The save bar is App Bridge's; here it renders its buttons in place.
vi.mock("@shopify/app-bridge-react", () => ({
  SaveBar: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="save-bar">{children}</div> : null,
}));
const {
  default: Appearance,
  action,
  loader,
  shouldRevalidate,
} = await import("./app.appearance");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SHOP = "fitted-dev.myshopify.com";
const json = (body: unknown) => new Response(JSON.stringify(body));

// One shop's `$app.settings`, enforcing compareDigest like Shopify. `down`
// makes every call fail.
function fakeStore(initial: Settings | null = null) {
  const store = {
    value: initial as Settings | null,
    digest: initial ? "d0" : null,
    writes: 0,
    down: false,
  };
  const graphql = vi.fn(
    async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      if (store.down) throw new Error("socket hang up");
      if (query.includes("query FittedSettings"))
        return json({
          data: {
            shop: {
              id: "gid://shopify/Shop/1",
              metafield: store.value && {
                jsonValue: store.value,
                compareDigest: store.digest,
              },
            },
            shopLocales: [
              { locale: "fr", primary: false },
              { locale: "en", primary: true },
            ],
          },
        });
      const [mf] = opts!.variables!.metafields as {
        ownerId: string;
        value: string;
        compareDigest: string | null;
      }[];
      expect(mf.ownerId).toBe("gid://shopify/Shop/1");
      if (mf.compareDigest !== store.digest)
        return json({
          data: {
            metafieldsSet: {
              metafields: [],
              userErrors: [{ message: "Stale", code: "STALE_OBJECT" }],
            },
          },
        });
      store.value = JSON.parse(mf.value);
      store.digest = `d${++store.writes}`;
      return json({
        data: {
          metafieldsSet: {
            metafields: [{ compareDigest: store.digest }],
            userErrors: [],
          },
        },
      });
    },
  );
  return Object.assign(store, { admin: { graphql } });
}
// Stored settings with a fit finder and a second language the screen never edits.
const saved = (): Settings => {
  const s = defaultSettings("en");
  s.fitFinder.askAge = true;
  s.text.fr = { label: "Guide", header: "Tailles", noFit: "Aucune." };
  return s;
};

let store: ReturnType<typeof fakeStore>;
let logs: string[];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SHOPIFY_API_KEY", "key123");
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line) => logs.push(line));
  store = fakeStore(saved());
  m.authenticate.mockImplementation(async () => ({
    admin: store.admin,
    session: { shop: SHOP },
  }));
});
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const request = (body?: unknown) =>
  new Request("https://fitted.test/app/appearance", {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const load = async () => {
  const r = await loader({ request: request() } as LoaderFunctionArgs);
  return { ...r, appearance: await r.appearance };
};
const post = async (body: unknown) => {
  const r = (await action({
    request: request(body),
  } as ActionFunctionArgs)) as {
    type?: string;
    data?: unknown;
    init?: ResponseInit;
  };
  return r?.type === "DataWithResponseInit"
    ? { status: r.init?.status, body: r.data }
    : { status: 200, body: r };
};
// The edits the screen sends for the stored settings, with changes.
const edits = (patch: Record<string, unknown> = {}) => ({
  link: { style: "button", icon: "hanger" },
  popup: { ...saved().popup, style: "drawer" },
  placement: { ...saved().placement, quickView: true },
  units: { default: "cm", toggle: false },
  colors: {
    mode: "custom",
    text: "#111111",
    accent: "#2448A8",
    background: "#FFFFFF",
  },
  css: ".fitted-link { color: red; }",
  label: "Fit guide",
  header: "Find your fit",
  ...patch,
});

describe("loading and saving appearance", () => {
  it("loads the shop's settings, defaults filled, with the theme editor link", async () => {
    const got = await load();
    expect(got.appearance).toMatchObject({
      settings: saved(),
      digest: "d0",
      primaryLocale: "en",
    });
    expect(got.themeUrl).toBe(
      "https://admin.shopify.com/store/fitted-dev/themes/current/editor?template=product&addAppBlockId=key123/size-guide&target=mainSection",
    );
  });

  it("saves the edits and reads them back, keeping the fit finder and other languages", async () => {
    expect(await post({ digest: "d0", edits: edits() })).toEqual({
      status: 200,
      body: { ok: true },
    });
    const { appearance } = await load();
    const s = (appearance as { settings: Settings }).settings;
    expect(s.link).toEqual({ style: "button", icon: "hanger" });
    expect(s.colors).toEqual(edits().colors);
    expect(s.units).toEqual({ default: "cm", toggle: false });
    expect(s.text.en).toEqual({
      ...saved().text.en,
      label: "Fit guide",
      header: "Find your fit",
    });
    expect(s.text.fr).toEqual(saved().text.fr);
    expect(s.fitFinder).toEqual(saved().fitFinder);
  });

  it("ignores anything but the digest and the edits from the browser", async () => {
    await post({
      digest: "d0",
      edits: { ...edits(), fitFinder: { type: "basic" }, text: {} },
      shopId: "gid://shopify/Shop/999",
      primaryLocale: "fr",
    });
    expect(store.value!.fitFinder).toEqual(saved().fitFinder);
    expect(store.value!.text.fr).toEqual(saved().text.fr);
    expect(store.value!.text.en.label).toBe("Fit guide");
  });

  it("refuses a save without a session before reading anything", async () => {
    m.authenticate.mockRejectedValue(new Response(null, { status: 401 }));
    await expect(post({ digest: "d0", edits: edits() })).rejects.toHaveProperty(
      "status",
      401,
    );
    expect(store.admin.graphql).not.toHaveBeenCalled();
  });

  it("answers 422 with the screen's field names, and writes nothing", async () => {
    const r = await post({
      digest: "d0",
      edits: edits({
        label: " ",
        colors: {
          mode: "custom",
          text: "#11",
          accent: "x",
          background: "#FFF",
        },
        popup: { ...saved().popup, style: "sideways" },
      }),
    });
    expect(r.status).toBe(422);
    expect(
      Object.keys((r.body as { fieldErrors: object }).fieldErrors),
    ).toEqual(
      expect.arrayContaining([
        "label",
        "colors.text",
        "colors.accent",
        "colors.background",
        "popup.style",
      ]),
    );
    expect(store.writes).toBe(0);
  });

  it("answers 422 to a body that isn't the edits", async () => {
    expect((await post("nonsense")).status).toBe(422);
    expect(store.writes).toBe(0);
  });

  it("refuses a replayed save as changed since, so it never overwrites", async () => {
    const body = { digest: "d0", edits: edits() };
    await post(body);
    expect(await post({ ...body, edits: edits({ label: "Old" }) })).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: expect.stringContaining("nothing was overwritten"),
        },
      },
    });
    expect(store.writes).toBe(1);
    expect(store.value!.text.en.label).toBe("Fit guide");
  });

  it("answers 502 in the screen's words when Shopify fails, logging the cause", async () => {
    store.down = true;
    const r = await post({ digest: "d0", edits: edits() });
    expect(r.status).toBe(502);
    expect(r.body).toEqual({
      error: { code: "shopify", message: expect.any(String) },
    });
    expect(JSON.stringify(r.body)).not.toContain("socket");
    expect(JSON.parse(logs[0])).toMatchObject({
      level: "error",
      shop: SHOP,
      route: "app.appearance",
    });
    expect((await load()).appearance).toMatchObject({
      error: { code: "load" },
    });
  });
});

// The screen, on the real loader and action over the fake store.
async function open() {
  const Stub = createRoutesStub([
    {
      path: "/app/appearance",
      Component: Appearance,
      HydrateFallback: () => null,
      loader: (args) => loader(args as LoaderFunctionArgs),
      action: (args) => action(args as ActionFunctionArgs),
      shouldRevalidate,
    },
  ]);
  const div = document.body.appendChild(document.createElement("div"));
  root = createRoot(div);
  await act(async () =>
    root!.render(<Stub initialEntries={["/app/appearance"]} />),
  );
  await settle();
}
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));
const text = () => document.body.textContent ?? "";
const saveBar = () => document.querySelector('[data-testid="save-bar"]');
const byId = (id: string) =>
  document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
const labelled = (label: string) =>
  [...document.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(label))!
    .querySelector("input, select") as HTMLInputElement;
const heading = () =>
  [...document.querySelectorAll("s-banner")].map((b) =>
    b.getAttribute("heading"),
  );
async function type(el: HTMLElement, value: string) {
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
const click = async (label: string | HTMLElement) => {
  const el =
    typeof label === "string"
      ? [...document.querySelectorAll<HTMLElement>("button, s-button")].find(
          (b) => b.textContent === label,
        )!
      : label;
  await act(async () => el.click());
  await settle();
};

describe("appearance screen", () => {
  it("edits every kind of control and saves, then reads back with the save bar closed", async () => {
    await open();
    expect(saveBar()).toBeNull();
    await click(labelled("Button"));
    await type(byId("label"), "Fit guide");
    await type(labelled("Icon"), "tape");
    await click(labelled("Show my logo in the popup"));
    await click(labelled("Collection pages and quick view"));
    await type(byId("placement.selector"), ".product-form");
    await type(labelled("Default unit"), "in");
    await type(byId("css"), ".fitted-link { color: red; }");
    expect(saveBar()).not.toBeNull();
    await click("Save");

    expect(store.value).toMatchObject({
      link: { style: "button", icon: "tape" },
      popup: { logo: false },
      placement: { quickView: true, selector: ".product-form" },
      colors: { mode: "theme" },
      units: { default: "in" },
      css: ".fitted-link { color: red; }",
      fitFinder: saved().fitFinder,
    });
    expect(store.value!.text.en.label).toBe("Fit guide");
    expect(saveBar()).toBeNull();
    expect(byId("label").value).toBe("Fit guide");
  });

  it("marks the fields to fix and sends nothing", async () => {
    await open();
    await type(byId("label"), "");
    await type(byId("header"), " ");
    await type(byId("placement.selector"), ".product-form__input--size >");
    await click("Save");

    expect(store.writes).toBe(0);
    expect(heading()).toEqual(["Fix 3 fields to save"]);
    expect(text()).toContain(
      "Nothing was saved, so your store hasn't changed.",
    );
    expect(text()).toContain("Label is empty");
    expect(text()).toContain("Header text is empty");
    expect(text()).toContain(
      "Place after this element isn't a valid CSS selector",
    );
    expect(text()).toContain("Enter the link text, like Size guide.");
    expect(text()).toContain(
      "Not a valid CSS selector. Check it for typos, or leave it empty to use the app block.",
    );
    expect(byId("placement.selector").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(byId("css").getAttribute("aria-invalid")).toBeNull();
  });

  it("marks custom CSS with a < or over 10 KB, and Discard puts everything back", async () => {
    await open();
    expect(text()).toContain(
      "Added as written to every page that shows the size guide: product pages, quick views and featured products. Start each rule with .fitted-guide to style only the size guide.",
    );
    expect(text()).not.toContain("Applies only to the size guide");
    await type(byId("css"), "<style>");
    await click("Save");
    expect(heading()).toEqual(["Fix 1 field to save"]);
    expect(text()).toContain("Custom CSS can't be saved as it is");
    expect(text()).toContain(`Custom CSS can't contain "<"`);
    await type(byId("css"), "a".repeat(10 * 1024 + 1));
    await click("Save");
    expect(text()).toContain("Keep custom CSS under 10 KB");
    expect(store.admin.graphql).toHaveBeenCalledTimes(1); // the load only: nothing sent

    await click("Discard");
    expect(byId("css").value).toBe("");
    expect(heading()).toEqual([]);
    expect(saveBar()).toBeNull();
  });

  it("shows changed elsewhere; Cancel keeps the edits, Reload latest discards them", async () => {
    await open();
    await type(byId("label"), "Mine");
    store.digest = "other-tab"; // another tab saved
    store.value = { ...saved(), css: ".theirs {}" };
    await click("Save");
    expect(heading()).toEqual(["Settings changed since you opened them"]);
    expect(text()).toContain(
      "Reload latest shows the newest settings and discards your edits.",
    );

    await click("Cancel");
    expect(heading()).toEqual([]);
    expect(byId("label").value).toBe("Mine");

    await click("Save");
    await click("Reload latest");
    expect(heading()).toEqual([]);
    expect(byId("label").value).toBe("Size guide");
    expect(byId("css").value).toBe(".theirs {}");
    expect(saveBar()).toBeNull();
  });

  it("keeps the edits when the save fails, and Try saving again saves them", async () => {
    await open();
    await type(byId("label"), "Fit guide");
    store.down = true;
    await click("Save");
    expect(heading()).toEqual(["Your appearance changes weren't saved"]);
    expect(byId("label").value).toBe("Fit guide");

    store.down = false;
    await click("Try saving again");
    expect(store.value!.text.en.label).toBe("Fit guide");
    expect(heading()).toEqual([]);
  });

  it("says so when the settings don't load, and Try again loads them", async () => {
    store.down = true;
    await open();
    expect(heading()).toEqual(["Your appearance settings didn't load"]);
    expect(text()).toContain("Still not working?");

    store.down = false;
    await click("Try again");
    expect(heading()).toEqual([]);
    expect(byId("label").value).toBe("Size guide");
  });
});

describe("colors, font and preview", () => {
  const preview = () =>
    document.querySelector('[aria-label="Product page preview"]')!;
  const picker = (name: string) =>
    document.querySelector<HTMLInputElement>(`[aria-label="${name} color"]`);
  const reopen = async () => {
    act(() => root?.unmount());
    document.body.innerHTML = "";
    await open();
  };

  it("saves colors picked or typed, reads them back, and the preview follows", async () => {
    await open();
    expect(labelled("Match my theme").checked).toBe(true);
    expect(byId("colors.accent").value).toBe("#2448A8");
    await type(picker("Text")!, "#111111"); // a swatch picks Custom
    expect(labelled("Custom").checked).toBe(true);
    await type(byId("colors.accent"), "#AA0000");
    await type(byId("label"), "Fit guide");
    expect(preview().textContent).toContain("Fit guide");
    const link = preview().querySelector<HTMLElement>(".link")!;
    expect(link.style.color.toLowerCase()).toMatch(/#aa0000|170, 0, 0/);
    await click("Save");
    expect(store.value!.colors).toEqual({
      mode: "custom",
      text: "#111111",
      accent: "#AA0000",
      background: "#FFFFFF",
    });

    await reopen();
    expect(labelled("Custom").checked).toBe(true);
    expect(byId("colors.text").value).toBe("#111111");
    expect(picker("Accent")!.value).toBe("#aa0000");

    // Matching the theme stores no colors.
    await click(labelled("Match my theme"));
    expect(preview().querySelector<HTMLElement>(".link")!.style.color).toBe("");
    await click("Save");
    expect(store.value!.colors).toEqual({ mode: "theme" });
  });

  it("marks a bad hex with the slashed swatch and sends nothing", async () => {
    await open();
    await type(byId("colors.accent"), "#2448A");
    expect(picker("Accent")).toBeNull();
    expect(document.querySelectorAll(".swatch")).toHaveLength(1);
    await click("Save");

    expect(store.writes).toBe(0);
    expect(heading()).toEqual(["Fix 1 field to save"]);
    expect(text()).toContain("Accent color isn't a valid hex code");
    expect(text()).toContain(
      "Accent needs # and 6 letters or numbers, like #2448A8.",
    );
    expect(byId("colors.accent").getAttribute("aria-invalid")).toBe("true");
    expect(byId("colors.accent").getAttribute("aria-describedby")).toBe(
      "colors.accent-err",
    );

    // Back to the theme: the unused hex is no change, and nothing is marked.
    await click(labelled("Match my theme"));
    expect(saveBar()).toBeNull();
  });

  it("shows the preview's card while loading", async () => {
    store.admin.graphql.mockImplementation(() => new Promise(() => {}));
    await open();
    expect(text()).toContain("Loading appearance settings");
    expect(document.querySelectorAll('[role="status"] > .card')).toHaveLength(
      1,
    );
  });

  it("keeps a stored font until Remove goes back to Match my theme", async () => {
    const s = saved();
    s.popup.font = { fileUrl: "https://cdn.shopify.com/s/files/1/a.woff2" };
    store = fakeStore(s);
    await open();
    expect(labelled("Font").value).toBe("upload");
    expect(text()).toContain("a.woff2Saved in your Shopify Files");
    await type(byId("label"), "Fit guide");
    await click("Save");
    expect(store.value!.popup.font).toEqual(s.popup.font);

    await click("Remove");
    expect(labelled("Font").value).toBe("theme");
    await click("Save");
    expect(store.value!.popup.font).toBe("theme");
  });
});

// Shopify Files behind the fake store: the staged upload, fileCreate and the
// file's status, with the staged target's POST on `fetch`.
const FILE_URL = "https://cdn.shopify.com/s/files/1/1/files/Sora.woff2?v=1";
// `statuses` answer the polls in turn, the last one repeating.
function fakeFiles({
  statuses = ["READY"],
  url = FILE_URL,
  target = 204,
} = {}) {
  const calls: { query: string; variables?: Record<string, unknown> }[] = [];
  const base = store.admin.graphql.getMockImplementation()!;
  const poll = (fileStatus: string) => ({
    node: { fileStatus, url: fileStatus === "READY" ? url : null },
  });
  const answer = (q: string) =>
    q.includes("FittedFontStage")
      ? {
          stagedUploadsCreate: {
            stagedTargets: [
              {
                url: "https://storage.test/upload",
                resourceUrl: "https://storage.test/tmp/Sora.woff2",
                parameters: [{ name: "key", value: "tmp/Sora.woff2" }],
              },
            ],
            userErrors: [],
          },
        }
      : q.includes("FittedFontCreate")
        ? {
            fileCreate: {
              files: [{ id: "gid://shopify/GenericFile/1" }],
              userErrors: [],
            },
          }
        : q.includes("FittedFontDrop")
          ? {
              fileDelete: {
                deletedFileIds: ["gid://shopify/GenericFile/1"],
                userErrors: [],
              },
            }
          : poll(statuses.length > 1 ? statuses.shift()! : statuses[0]);
  store.admin.graphql.mockImplementation(async (query, opts) => {
    if (!query.includes("FittedFont")) return base(query, opts);
    calls.push({ query, variables: opts?.variables });
    return json({ data: answer(query) });
  });
  const sent = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status: target }));
  // The files made and not deleted again.
  const left = () =>
    calls.filter((c) => c.query.includes("FittedFontCreate")).length -
    calls.filter((c) => c.query.includes("FittedFontDrop")).length;
  return { calls, sent, left };
}
const WOFF2 = [0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0];
const font = (name = "Sora.woff2", bytes = WOFF2, size = bytes.length) => {
  const b = new Uint8Array(size);
  b.set(bytes);
  return new File([b], name);
};
const postFont = async (file: File, signal?: AbortSignal) => {
  const body = new FormData();
  body.append("file", file);
  const r = (await action({
    request: new Request("https://fitted.test/app/appearance", {
      method: "POST",
      body,
      signal,
    }),
  } as ActionFunctionArgs)) as {
    type?: string;
    data?: unknown;
    init?: ResponseInit;
  };
  return r?.type === "DataWithResponseInit"
    ? { status: r.init?.status, body: r.data }
    : { status: 200, body: r };
};
const refused = (words: string) => ({
  status: 422,
  body: { fieldErrors: { "popup.font": words } },
});

describe("uploading a font", () => {
  it("sends a font to Shopify Files and answers its address", async () => {
    const { calls, sent } = fakeFiles();
    expect(await postFont(font("My Sora (1).woff2"))).toEqual({
      status: 200,
      body: { fileUrl: FILE_URL },
    });
    expect(calls[0].variables).toEqual({
      input: [
        {
          resource: "FILE",
          filename: "My-Sora-1-.woff2",
          mimeType: "font/woff2",
          httpMethod: "POST",
          fileSize: "8",
        },
      ],
    });
    const form = sent.mock.calls[0][1]!.body as FormData;
    expect(sent.mock.calls[0][0]).toBe("https://storage.test/upload");
    expect([...form.keys()]).toEqual(["key", "file"]);
    expect(calls[1].variables).toEqual({
      files: [
        {
          originalSource: "https://storage.test/tmp/Sora.woff2",
          contentType: "FILE",
        },
      ],
    });
    expect(calls[2].variables).toEqual({ id: "gid://shopify/GenericFile/1" });
    // The address it answers is one the settings accept.
    const uploaded = { fileUrl: FILE_URL };
    const popup = { ...saved().popup, font: uploaded };
    expect((await post({ digest: "d0", edits: edits({ popup }) })).status).toBe(
      200,
    );
    expect(store.value!.popup.font).toEqual(uploaded);
  });

  it("refuses an upload without a session before reading it", async () => {
    const { calls, sent } = fakeFiles();
    m.authenticate.mockRejectedValue(new Response(null, { status: 401 }));
    await expect(postFont(font())).rejects.toBeInstanceOf(Response);
    expect(calls).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
  });

  it("checks the bytes as well as the name, and the 2 MB limit", async () => {
    const { calls } = fakeFiles();
    const zip = [0x50, 0x4b, 3, 4];
    expect(await postFont(font("Sora.woff2", zip))).toEqual(
      refused("Use a WOFF2, WOFF, TTF or OTF file."),
    );
    expect(await postFont(font("Sora.zip"))).toEqual(
      refused("Use a WOFF2, WOFF, TTF or OTF file."),
    );
    const size = refused("Use a font file up to 2 MB, like a WOFF2.");
    expect(
      await postFont(font("Big.woff2", WOFF2, 2 * 1024 * 1024 + 1)),
    ).toEqual(size);
    expect(await postFont(font("Big.woff2", WOFF2, 3 * 1024 * 1024))).toEqual(
      size,
    );
    expect(calls).toEqual([]);
  });

  it("answers 502 when Shopify doesn't take the file, logging the cause", async () => {
    fakeFiles({ target: 500 });
    const failed = {
      status: 502,
      body: {
        error: {
          code: "upload",
          message:
            "Shopify didn't answer, so the popup still uses your theme's font.",
        },
      },
    };
    expect(await postFont(font())).toEqual(failed);
    expect(JSON.parse(logs[0])).toEqual({
      level: "error",
      msg: "The font didn't reach Shopify",
      shop: SHOP,
      route: "app.appearance",
    });
    fakeFiles({ statuses: ["FAILED"] });
    expect(await postFont(font())).toEqual(failed);
    // Shopify's answer is checked too: only a Shopify Files address is kept.
    fakeFiles({ url: "https://evil.test/x.woff2" });
    expect(await postFont(font())).toEqual(failed);
    const { sent } = fakeFiles();
    sent.mockRejectedValue(new TypeError("fetch failed"));
    expect(await postFont(font())).toEqual(failed);
  });

  it("deletes the file it made when Shopify doesn't keep it, and only that one", async () => {
    for (const statuses of [["FAILED"], ["READY"]]) {
      const files = fakeFiles({ statuses, url: "https://evil.test/x.woff2" });
      expect((await postFont(font())).status).toBe(502);
      expect(files.left()).toBe(0);
      expect(files.calls.at(-1)!.variables).toEqual({
        ids: ["gid://shopify/GenericFile/1"],
      });
    }
    // A failed delete is logged, and the answer stays the same.
    const files = fakeFiles({ statuses: ["FAILED"] });
    const base = store.admin.graphql.getMockImplementation()!;
    store.admin.graphql.mockImplementation(async (q, o) =>
      q.includes("FittedFontDrop")
        ? json({ errors: [{ message: "Throttled" }] })
        : base(q, o),
    );
    expect((await postFont(font())).status).toBe(502);
    expect(files.left()).toBe(1);
    expect(logs.map((l) => JSON.parse(l).msg)).toContain(
      "Shopify didn't delete the dropped font",
    );
  });

  it("deletes the file when the screen stops waiting for it", async () => {
    // Gone once Shopify has made the file: it's deleted again.
    const files = fakeFiles({ statuses: ["PROCESSING", "READY"] });
    const gone = new AbortController();
    const base = store.admin.graphql.getMockImplementation()!;
    store.admin.graphql.mockImplementation(async (q, o) => {
      if (q.includes("FittedFontCreate")) gone.abort();
      return base(q, o);
    });
    expect((await postFont(font(), gone.signal)).status).toBe(502);
    expect(files.left()).toBe(0);

    // Gone before that: no file is made at all.
    const early = fakeFiles();
    const left = new AbortController();
    early.sent.mockImplementation(async () => {
      left.abort();
      return new Response(null, { status: 204 });
    });
    expect((await postFont(font(), left.signal)).status).toBe(502);
    expect(early.calls).toHaveLength(1);
    expect(early.calls[0].query).toContain("FittedFontStage");
    // The merchant chose to drop it, so nothing is logged as an error.
    expect(logs).toEqual([]);
  });

  it("waits while Shopify processes the file, and gives up after 20 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const run = async () => {
      const answer = postFont(font());
      await vi.advanceTimersByTimeAsync(25_000);
      return answer;
    };
    const { calls } = fakeFiles({
      statuses: ["UPLOADED", "PROCESSING", "READY"],
    });
    expect((await run()).body).toEqual({ fileUrl: FILE_URL });
    const polls = calls.filter((c) => c.query.includes("FittedFontFile"));
    expect(polls).toHaveLength(3);

    fakeFiles({ statuses: ["PROCESSING"] });
    expect((await run()).status).toBe(502);
    expect(JSON.parse(logs.at(-1)!).msg).toBe("The font took too long");
  });

  it("knows each kind of font by its first bytes", () => {
    const head = (...b: number[]) => new Uint8Array(b);
    expect(fontType("a.WOFF", head(0x77, 0x4f, 0x46, 0x46))).toBe("font/woff");
    expect(fontType("a.ttf", head(0, 1, 0, 0))).toBe("font/ttf");
    expect(fontType("a.otf", head(0x4f, 0x54, 0x54, 0x4f))).toBe("font/otf");
    expect(fontType("a.ttf", head(0x77, 0x4f, 0x46))).toBeUndefined();
    expect(fontType("constructor", head(0, 1, 0, 0))).toBeUndefined();
    expect(fileSize(48 * 1024)).toBe("48 KB");
    expect(fileSize(6.35 * 1024 * 1024)).toBe("6.4 MB");
  });
});

describe("font upload screen", () => {
  const choose = async (file: File) => {
    const input = document.querySelector<HTMLInputElement>('[type="file"]')!;
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    await act(async () =>
      input.dispatchEvent(new Event("change", { bubbles: true })),
    );
    await settle();
  };

  it("chooses a file, uploads it, and saves it as the popup's font", async () => {
    const { calls } = fakeFiles();
    await open();
    await type(labelled("Font"), "upload");
    expect(text()).toContain(
      "Add font fileor drop it here. WOFF2, WOFF, TTF or OTF, up to 2 MB.",
    );
    expect(saveBar()).toBeNull();
    await choose(font("Sora-Regular.woff2", WOFF2, 48 * 1024));
    expect(calls).toHaveLength(3);
    expect(text()).toContain(
      "Sora-Regular.woff248 KB, saved in your Shopify Files",
    );
    await click("Save");
    expect(store.value!.popup.font).toEqual({ fileUrl: FILE_URL });
    expect(text()).toContain("48 KB, saved in your Shopify Files");
  });

  it("says when a file isn't a font or is too large, and sends nothing", async () => {
    const { calls } = fakeFiles();
    await open();
    await type(labelled("Font"), "upload");
    await choose(font("Sora.zip"));
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      "Sora.zip isn't a font fileUse a WOFF2, WOFF, TTF or OTF file.Add font file",
    );
    await choose(font("Sora-Variable.ttf", [0, 1, 0, 0], 6.4 * 1024 * 1024));
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      "Sora-Variable.ttf is 6.4 MBUse a font file up to 2 MB, like a WOFF2.Add font file",
    );
    expect(calls).toEqual([]);
  });

  it("says when the upload failed, and Try again sends the same file", async () => {
    fakeFiles({ target: 503 });
    await open();
    await type(labelled("Font"), "upload");
    await choose(font("Sora-Regular.woff2"));
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      "Sora-Regular.woff2 didn't uploadShopify didn't answer, so the popup still uses your theme's font.Try again",
    );
    const { sent } = fakeFiles();
    await click("Try again");
    expect(sent).toHaveBeenCalledTimes(1);
    expect((sent.mock.calls[0][1]!.body as FormData).get("file")).toBeTruthy();
    expect(text()).toContain("Sora-Regular.woff2");
    expect(text()).toContain("saved in your Shopify Files");
    expect(labelled("Font").value).toBe("upload");
  });

  // The staged upload's POST waits until `release` is called.
  const holdUpload = () => {
    const { calls, sent, left } = fakeFiles();
    let release = () => {};
    sent.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r(new Response(null, { status: 204 }));
        }),
    );
    return { calls, left, release: () => release() };
  };
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    )!;

  it("takes a dropped file", async () => {
    const { calls } = fakeFiles();
    await open();
    await type(labelled("Font"), "upload");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [font("Sora-Regular.woff2")] },
    });
    await act(async () =>
      document.querySelector(".font-drop")!.dispatchEvent(drop),
    );
    await settle();
    expect(drop.defaultPrevented).toBe(true);
    expect(calls).toHaveLength(3);
    expect(text()).toContain("Sora-Regular.woff2");
    expect(text()).toContain("saved in your Shopify Files");
  });

  it("holds Save while a font uploads, then saves it with the other edits", async () => {
    const upload = holdUpload();
    await open();
    await type(byId("label"), "Fit guide");
    await type(labelled("Font"), "upload");
    await choose(font("Sora-Regular.woff2"));
    expect(document.querySelector('[role="status"]')!.textContent).toBe(
      "Uploading Sora-Regular.woff2",
    );
    expect(button("Save").disabled).toBe(true);
    upload.release();
    await settle();
    expect(button("Save").disabled).toBe(false);
    await click("Save");
    expect(store.value!.popup.font).toEqual({ fileUrl: FILE_URL });
    expect(store.value!.text.en.label).toBe("Fit guide");
  });

  it("holds Try saving again while a font uploads", async () => {
    await open();
    await type(byId("label"), "Fit guide");
    store.down = true;
    await click("Save");
    store.down = false;
    const upload = holdUpload();
    await type(labelled("Font"), "upload");
    await choose(font("Sora-Regular.woff2"));
    const retry = () =>
      [...document.querySelectorAll("s-button")].find(
        (b) => b.textContent === "Try saving again",
      )!;
    expect(retry().hasAttribute("disabled")).toBe(true);
    upload.release();
    await settle();
    expect(retry().hasAttribute("disabled")).toBe(false);
  });

  // The settings write waits until `release` is called.
  const holdSave = () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const base = store.admin.graphql.getMockImplementation()!;
    store.admin.graphql.mockImplementation(async (q, o) => {
      if (q.includes("SaveFittedSettings")) await gate;
      return base(q, o);
    });
    return { release: () => release() };
  };

  it.each(["before", "after"])(
    "keeps a font picked while a save runs, uploaded %s the save ends",
    async (when) => {
      const upload = holdUpload();
      await open();
      await type(byId("label"), "Fit guide");
      const save = holdSave();
      await click("Save");
      await type(labelled("Font"), "upload");
      await choose(font("Sora-Regular.woff2"));
      const [first, second] =
        when === "before" ? [upload, save] : [save, upload];
      first.release();
      await settle();
      second.release();
      await settle();
      expect(store.value!.text.en.label).toBe("Fit guide");
      expect(text()).toContain("Sora-Regular.woff2");
      expect(text()).toContain("saved in your Shopify Files");
      await click("Save");
      expect(store.value!.popup.font).toEqual({ fileUrl: FILE_URL });
    },
  );

  it("says when a font picked during a save didn't upload, and keeps the theme's font", async () => {
    const s = saved();
    s.popup.font = { fileUrl: "https://cdn.shopify.com/s/files/1/a.woff2" };
    store = fakeStore(s);
    fakeFiles({ target: 503 });
    await open();
    await type(byId("label"), "Fit guide");
    const save = holdSave();
    await click("Save");
    await choose(font("Sora-Regular.woff2"));
    save.release();
    await settle();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "Sora-Regular.woff2 didn't upload",
    );
    await click("Save");
    expect(store.value!.popup.font).toBe("theme");
  });

  it("holds Reload latest while a font uploads, and the upload reads nothing again", async () => {
    await open();
    await type(byId("label"), "Mine");
    store.digest = "other-tab";
    await click("Save");
    const upload = holdUpload();
    await type(labelled("Font"), "upload");
    await choose(font("Sora-Regular.woff2"));
    const reload = () =>
      [...document.querySelectorAll("s-button")].find(
        (b) => b.textContent === "Reload latest",
      )!;
    expect(reload().hasAttribute("disabled")).toBe(true);
    upload.release();
    await settle();
    expect(reload().hasAttribute("disabled")).toBe(false);
    expect(text()).toContain("saved in your Shopify Files");
    // Settings changed elsewhere, yet the edits stay until Reload latest.
    expect(byId("label").value).toBe("Mine");
  });

  it.each(["Match my theme", "Discard"])(
    "drops an upload when %s is picked while it runs, and deletes its file",
    async (how) => {
      const upload = holdUpload();
      await open();
      // An edit, so the save bar and its Discard show.
      await type(byId("label"), "Fit guide");
      await type(labelled("Font"), "upload");
      await choose(font("Sora-Regular.woff2"));
      if (how === "Discard") await click("Discard");
      else {
        await type(byId("label"), "Size guide");
        await type(labelled("Font"), "theme");
      }
      upload.release();
      await settle();
      expect(labelled("Font").value).toBe("theme");
      expect(text()).not.toContain("Sora-Regular.woff2");
      expect(saveBar()).toBeNull();
      expect(upload.left()).toBe(0);
    },
  );

  it("keeps a stored font through a refused Replace, and Discard brings it back after a failed one", async () => {
    const s = saved();
    s.popup.font = { fileUrl: "https://cdn.shopify.com/s/files/1/a.woff2" };
    store = fakeStore(s);
    fakeFiles({ target: 503 });
    await open();
    await choose(font("notes.txt"));
    expect(text()).toContain("notes.txt isn't a font file");
    expect(saveBar()).toBeNull();

    await choose(font("Sora-Regular.woff2"));
    expect(text()).toContain("Sora-Regular.woff2 didn't upload");
    await click("Discard");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(text()).toContain("a.woff2Saved in your Shopify Files");

    await type(labelled("Font"), "theme");
    await click("Save");
    expect(store.value!.popup.font).toBe("theme");
  });

  it("says an unreadable file isn't a font", async () => {
    const { calls } = fakeFiles();
    await open();
    await type(labelled("Font"), "upload");
    const f = font("Sora.woff2");
    f.slice = () => {
      const b = new Blob();
      b.arrayBuffer = () => Promise.reject(new DOMException("gone"));
      return b;
    };
    await choose(f);
    expect(text()).toContain("Sora.woff2 isn't a font file");
    expect(calls).toEqual([]);
  });
});
