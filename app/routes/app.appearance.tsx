// Appearance & languages (ARCHITECTURE §7, §15): the Appearance board's link,
// popup, placement, units and custom CSS, saved to `$app.settings` through
// App Bridge's save bar, with colors, the popup font and the product page
// preview, and the popup font's upload to Shopify Files. Languages is #43's.
import { Suspense, useState, type ReactNode } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Await,
  data,
  useFetcher,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { SaveBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  type Admin,
  AdminApiError,
  themeEditorUrl,
} from "../models/admin.server";
import { uploadFont } from "../models/font.server";
import { FONT_MAX, FONT_WORDS, fontType } from "../lib/appearance";
import {
  FONT_FAILED,
  useFontUpload,
} from "../components/appearance/FontUpload";
import {
  type FieldErrors,
  type Loaded,
  type Settings,
  SettingsConflictError,
  SettingsReadWriteError,
  SettingsValidationError,
  getSettings,
  saveSettings,
} from "../models/settings.server";
import { Banner } from "../components/rules/RulesEditor";
import "../components/chart-table/editor.css";
import "../components/appearance/appearance.css";

const log = (shop: string, err: Error) =>
  console.log(
    JSON.stringify({ level: "error", msg: err.message, shop, route: ROUTE }),
  );
const ROUTE = "app.appearance";

// The canvas's words: a heading, then its lines; "**" marks the bold one.
const COPY: Record<string, string[]> = {
  load: [
    "Your appearance settings didn't load",
    "Fitted couldn't reach your store just now. Shoppers still see your size guide as it was.",
  ],
  conflict: [
    "Settings changed since you opened them",
    "Your edits weren't saved, so nothing was overwritten.",
    "**Reload latest shows the newest settings and discards your edits.",
  ],
  shopify: [
    "Your appearance changes weren't saved",
    "Shopify didn't respond in time, so shoppers still see the size guide as it was. Your edits are still here.",
  ],
};
const refusal = (code: string) => ({
  error: { code, message: COPY[code].slice(1).join(" ").replace("**", "") },
});

async function load(admin: Parameters<typeof getSettings>[0], shop: string) {
  try {
    return await getSettings(admin);
  } catch (err) {
    if (!(err instanceof SettingsReadWriteError)) throw err;
    log(shop, err);
    return refusal("load");
  }
}

// Streamed, so the screen shows its loading state while Shopify answers.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  return {
    appearance: load(admin, session.shop),
    themeUrl: themeEditorUrl(session.shop),
  };
};

// What the screen sends whole, with the primary language's label and header.
// The fit finder and other languages stay as stored.
const SECTIONS = ["link", "popup", "placement", "units"] as const;
const EDITED = [...SECTIONS, "colors", "css"] as const;

// The font upload: at most the file and its form's fields are read, the file
// is checked by its name and bytes, and it goes on to Shopify Files.
const FONT_BODY = FONT_MAX + 64 * 1024;
async function upload(request: Request, admin: Admin, shop: string) {
  let seen = 0;
  const cap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      seen += chunk.byteLength;
      if (seen > FONT_BODY) c.error(new Error("Too large"));
      else c.enqueue(chunk);
    },
  });
  const headers = { "content-type": request.headers.get("content-type")! };
  const form = await new Response(request.body?.pipeThrough(cap), { headers })
    .formData()
    .catch(() => null);
  const file = form?.get("file");
  const refuse = (k: keyof typeof FONT_WORDS) =>
    data({ fieldErrors: { "popup.font": FONT_WORDS[k] } }, { status: 422 });
  if (seen > FONT_BODY) return refuse("size");
  if (!(file instanceof File)) return refuse("type");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = fontType(file.name, bytes);
  if (!mime) return refuse("type");
  if (bytes.length > FONT_MAX) return refuse("size");
  try {
    return {
      fileUrl: await uploadFont(admin, { name: file.name, mime, bytes }),
    };
  } catch (err) {
    if (!(err instanceof AdminApiError)) throw err;
    log(shop, err);
    return data(
      { error: { code: "upload", message: FONT_FAILED } },
      { status: 502 },
    );
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (request.headers.get("content-type")?.startsWith("multipart/form-data"))
    return upload(request, admin, session.shop);
  const body = await request.json().catch(() => null);
  try {
    // Only the digest and the edits come from the browser (§3).
    const loaded = await getSettings(admin);
    const { settings: s, primaryLocale: l } = loaded;
    const e = body?.edits ?? {};
    const words = { ...s.text[l], label: e.label, header: e.header };
    const input = {
      ...s,
      ...Object.fromEntries(EDITED.map((k) => [k, e[k]])),
      text: { ...s.text, [l]: words },
    };
    const digest = typeof body?.digest === "string" ? body.digest : null;
    await saveSettings(admin, { ...loaded, digest }, input);
    return { ok: true as const };
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      // The primary language's words go by the screen's names.
      const fieldErrors: FieldErrors = {};
      for (const [path, message] of Object.entries(err.fieldErrors))
        fieldErrors[path.replace(/^text\.[^.]+\.(label|header)$/, "$1")] =
          message;
      return data({ fieldErrors }, { status: 422 });
    }
    if (err instanceof SettingsConflictError)
      return data(refusal("conflict"), { status: 409 });
    if (!(err instanceof SettingsReadWriteError)) throw err;
    log(session.shop, err);
    return data(refusal("shopify"), { status: 502 });
  }
};

// The Appearance board's states: loading, couldn't load, and the editor.
export default function Appearance() {
  const { appearance, themeUrl } = useLoaderData<typeof loader>();
  return (
    <Suspense fallback={<Page body={<Loading />} />}>
      <Await resolve={appearance} errorElement={<Page body={<LoadError />} />}>
        {(a) =>
          "error" in a ? (
            <Page body={<LoadError />} />
          ) : (
            <Editor key={a.digest ?? "new"} loaded={a} themeUrl={themeUrl} />
          )
        }
      </Await>
    </Suspense>
  );
}

// `side` is the preview, beside the form until space runs out.
const Page = (props: {
  banners?: ReactNode;
  body: ReactNode;
  side?: ReactNode;
}) => (
  <s-page>
    <div className="editor appearance">
      {props.banners}
      <div>
        <h1>Appearance &amp; languages</h1>
        <p className="help">
          Make the size guide look like part of your store.
        </p>
      </div>
      {props.side ? (
        <div className="split">
          <div className="form">{props.body}</div>
          {props.side}
        </div>
      ) : (
        props.body
      )}
    </div>
  </s-page>
);

const Loading = () => (
  <div role="status" className="split">
    <span className="visually-hidden">Loading appearance settings</span>
    <div className="form">
      {[3, 6, 4].map((rows) => (
        <div key={rows} className="card">
          {Array.from({ length: rows }, (_, i) => (
            <span key={i} className="sk" style={{ width: `${90 - i * 9}%` }} />
          ))}
        </div>
      ))}
    </div>
    <div className="card">
      {[
        ["35%", "1rem"],
        ["100%", "12.5rem"],
        ["60%", "1.125rem"],
        ["30%"],
        ["100%", "2.75rem"],
      ].map(([width, height]) => (
        <span key={width + height} className="sk" style={{ width, height }} />
      ))}
    </div>
  </div>
);

const button = (label: string, onClick: () => void) => (
  <s-button slot="secondary-actions" onClick={onClick}>
    {label}
  </s-button>
);

function LoadError() {
  const revalidator = useRevalidator();
  if (revalidator.state === "loading") return <Loading />;
  return (
    <>
      <Banner copy={COPY.load}>
        {button("Try again", () => revalidator.revalidate())}
      </Banner>
      <p className="help">
        Still not working? Email [SUPPORT EMAIL] and we&apos;ll look into it.
      </p>
    </>
  );
}

type Answer = {
  ok?: true;
  fieldErrors?: FieldErrors;
  error?: { code: string; message: string };
};
// By path ("popup.logo"), so each control reads and writes one value.
type Draft = Record<string, unknown>;
// The swatches' colors while the store has none.
const COLORS = { text: "#202223", accent: "#2448A8", background: "#FFFFFF" };
const HEX = /^#[0-9a-f]{6}$/i;
function toDraft({ settings: s, primaryLocale: l }: Loaded): Draft {
  const { label, header } = s.text[l];
  const d: Draft = { css: s.css, label, header };
  for (const k of SECTIONS)
    for (const [f, v] of Object.entries(s[k])) d[`${k}.${f}`] = v;
  for (const [f, v] of Object.entries({ ...COLORS, ...s.colors }))
    d[`colors.${f}`] = v;
  return d;
}
function toEdits(d: Draft) {
  const e: Record<string, unknown> = {};
  for (const [path, v] of Object.entries(d)) {
    const [k, f] = path.split(".");
    e[k] = f ? { ...(e[k] as object), [f]: v } : v;
  }
  // Matching the theme stores no colors.
  if (d["colors.mode"] === "theme") e.colors = { mode: "theme" };
  return e;
}

// "Fix the marked fields": each field's name in the banner, what's wrong, and
// the words under it. The server's check words the rest.
const FIELDS: Record<string, [string, string, string?]> = {
  label: ["Label", "is empty", "Enter the link text, like Size guide."],
  header: [
    "Header text",
    "is empty",
    "Enter the popup's title, like Size guide.",
  ],
  "placement.selector": [
    "Place after this element",
    "isn't a valid CSS selector",
    "Not a valid CSS selector. Check it for typos, or leave it empty to use the app block.",
  ],
  css: ["Custom CSS", "can't be saved as it is"],
};
const NAMES = { text: "Text", accent: "Accent", background: "Background" };
for (const [k, name] of Object.entries(NAMES))
  FIELDS[`colors.${k}`] = [
    `${name} color`,
    "isn't a valid hex code",
    `${name} needs # and 6 letters or numbers, like ${COLORS[k as keyof typeof COLORS]}.`,
  ];

/** The screen's own check, before anything is sent. */
function check(d: Draft): FieldErrors {
  const e: FieldErrors = {};
  for (const k of ["label", "header"])
    if (!String(d[k]).trim()) e[k] = "Missing";
  const selector = String(d["placement.selector"]);
  try {
    // The browser's own selector parser.
    if (selector) document.createDocumentFragment().querySelector(selector);
  } catch {
    e["placement.selector"] = "Not a selector";
  }
  if (d["colors.mode"] === "custom")
    for (const k of Object.keys(NAMES))
      if (!HEX.test(String(d[`colors.${k}`]))) e[`colors.${k}`] = "Not a hex";
  const css = String(d.css);
  if (css.includes("<")) e.css = `Custom CSS can't contain "<"`;
  else if (new Blob([css]).size > 10 * 1024)
    e.css = "Keep custom CSS under 10 KB";
  return e;
}

function Editor(props: { loaded: Loaded; themeUrl: string }) {
  const fetcher = useFetcher<Answer>();
  const revalidator = useRevalidator();
  const [initial] = useState(() => toDraft(props.loaded));
  const [draft, setDraft] = useState(initial);
  const [local, setLocal] = useState<Answer | null>(null);
  const [dismissed, setDismissed] = useState<Answer>();
  const saving = fetcher.state !== "idle";
  const answer = saving ? undefined : fetcher.data;
  const notice = local ?? (answer === dismissed ? undefined : answer);
  const errors = notice?.fieldErrors ?? {};
  const marked = Object.keys(errors);
  const code = notice?.error?.code;

  const save = () => {
    const found = check(draft);
    if (Object.keys(found).length) return setLocal({ fieldErrors: found });
    setLocal(null);
    const body = { digest: props.loaded.digest, edits: toEdits(draft) };
    fetcher.submit(body as never, {
      method: "post",
      encType: "application/json",
    });
  };
  const dismiss = () => {
    setLocal(null);
    setDismissed(answer);
  };
  const put = (id: string, v: unknown) => setDraft((d) => ({ ...d, [id]: v }));

  const err = (id: string) =>
    errors[id] && (
      <p key={id} id={`${id}-err`} className="help err">
        <s-icon type="alert-circle" tone="critical" size="small" />
        {FIELDS[id]?.[2] ?? errors[id]}
      </p>
    );
  const text = (id: string, label: string, help = "", wide = false) => {
    const Tag = id === "css" ? "textarea" : "input";
    return (
      <div className={wide ? "wide" : undefined}>
        <label>
          {label}
          <Tag
            id={id}
            className={errors[id] ? "field bad" : "field"}
            aria-invalid={errors[id] ? true : undefined}
            aria-describedby={errors[id] ? `${id}-err` : undefined}
            {...(Tag === "input" ? { maxLength: 200 } : { rows: 3 })}
            value={String(draft[id])}
            onChange={(e) => put(id, e.target.value)}
          />
        </label>
        {err(id) || (help && <p className="help">{help}</p>)}
      </div>
    );
  };
  const radios = (id: string, legend: string, options: string[][]) => (
    <fieldset>
      <legend>{legend}</legend>
      {options.map(([v, label]) => (
        <label key={v} className="choice">
          <input
            type="radio"
            name={id}
            checked={draft[id] === v}
            onChange={() => put(id, v)}
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
  // With `help` (null for none), the label is bold, as the canvas draws it.
  const box = (id: string, label: string, help?: ReactNode) => (
    <label className="choice">
      <input
        type="checkbox"
        checked={draft[id] === true}
        onChange={(e) => put(id, e.target.checked)}
      />
      {help === undefined ? (
        label
      ) : (
        <span>
          <strong>{label}</strong>
          {help && <span className="help">{help}</span>}
        </span>
      )}
    </label>
  );
  const select = (id: string, label: string, options: string[][]) => (
    <label>
      {label}
      <select
        className="field"
        value={String(draft[id])}
        onChange={(e) => put(id, e.target.value)}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );

  // A swatch to pick with, and the typed hex box beside it. Either picks Custom.
  const color = (k: keyof typeof NAMES) => {
    const id = `colors.${k}`;
    const v = String(draft[id]);
    const set = (value: string) =>
      setDraft((d) => ({ ...d, [id]: value, "colors.mode": "custom" }));
    return (
      <div key={k}>
        <label htmlFor={id}>{NAMES[k]}</label>
        <div className="hex">
          {HEX.test(v) ? (
            <input
              type="color"
              aria-label={`${NAMES[k]} color`}
              value={v.toLowerCase()}
              onChange={(e) => set(e.target.value.toUpperCase())}
            />
          ) : (
            <span className="swatch" aria-hidden="true" />
          )}
          <input
            id={id}
            className={errors[id] ? "field bad" : "field"}
            aria-invalid={errors[id] ? true : undefined}
            aria-describedby={errors[id] ? `${id}-err` : undefined}
            maxLength={7}
            value={v}
            onChange={(e) => set(e.target.value)}
          />
        </div>
      </div>
    );
  };
  const fontUpload = useFontUpload(
    draft["popup.font"] as Settings["popup"]["font"],
    (v) => put("popup.font", v),
  );
  const custom = draft["colors.mode"] === "custom";
  // The canvas's product, showing the label and custom colors.
  const preview = (
    <aside className="card" aria-label="Product page preview">
      <div className="row">
        <h2>Preview</h2>
        <span className="badge">Product page</span>
      </div>
      <div
        className="product"
        style={
          custom
            ? {
                color: String(draft["colors.text"]),
                background: String(draft["colors.background"]),
              }
            : undefined
        }
      >
        <div className="photo">Product photo</div>
        <strong className="name">Linen Wrap Top</strong>
        <span>$58.00</span>
        <div className="row">
          <strong>Size</strong>
          <span
            className="link"
            style={
              custom ? { color: String(draft["colors.accent"]) } : undefined
            }
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 15.5 15.5 3l5.5 5.5L8.5 21z" />
              <path d="m7 12 2 2M10 9l2 2M13 6l2 2" />
            </svg>
            {String(draft.label)}
          </span>
        </div>
        <div className="pills">
          {["XS", "S", "M", "L", "XL"].map((size) => (
            <span key={size} className={size === "M" ? "on" : ""}>
              {size}
            </span>
          ))}
        </div>
        <span className="cart">Add to cart</span>
      </div>
    </aside>
  );

  const banners = (
    <>
      {code === "conflict" ? (
        <Banner copy={COPY.conflict}>
          {button("Reload latest", () => revalidator.revalidate())}
          {button("Cancel", dismiss)}
        </Banner>
      ) : (
        code && (
          <Banner copy={COPY.shopify}>
            {button("Try saving again", save)}
          </Banner>
        )
      )}
      {marked.length > 0 && (
        <Banner
          copy={[
            `Fix ${marked.length} field${marked.length === 1 ? "" : "s"} to save`,
            "Nothing was saved, so your store hasn't changed.",
          ]}
        >
          <ul className="list">
            {marked.map((id) => (
              <li key={id}>
                {FIELDS[id] ? (
                  <>
                    <a
                      href={`#${id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(id)?.focus();
                      }}
                    >
                      {FIELDS[id][0]}
                    </a>{" "}
                    {FIELDS[id][1]}
                  </>
                ) : (
                  `${id}: ${errors[id]}`
                )}
              </li>
            ))}
          </ul>
        </Banner>
      )}
    </>
  );

  return (
    <>
      <SaveBar
        id="appearance-save-bar"
        open={
          saving ||
          JSON.stringify(toEdits(draft)) !== JSON.stringify(toEdits(initial))
        }
      >
        <button
          variant="primary"
          onClick={save}
          loading={saving ? "" : undefined}
        >
          Save
        </button>
        <button
          disabled={saving}
          onClick={() => {
            setDraft(initial);
            fontUpload.reset();
            dismiss();
          }}
        >
          Discard
        </button>
      </SaveBar>
      <Page
        banners={banners}
        body={
          <>
            <section className="card" aria-labelledby="h-link">
              <h2 id="h-link">Size guide link</h2>
              {radios("link.style", "Style", [
                ["text", "Text link"],
                ["button", "Button"],
                ["tab", "Floating tab"],
              ])}
              <div className="fields">
                {text("label", "Label", "", true)}
                {select("link.icon", "Icon", [
                  ["ruler", "Ruler"],
                  ["hanger", "Hanger"],
                  ["tape", "Tape measure"],
                  ["none", "None"],
                ])}
              </div>
            </section>

            <section className="card" aria-labelledby="h-popup">
              <h2 id="h-popup">Popup</h2>
              {radios("popup.style", "Style", [
                ["center", "Centered"],
                ["drawer", "Side drawer"],
              ])}
              {box("popup.sheetOnPhone", "Open as a bottom sheet on phones")}
              <div className="fields">
                {select("popup.openFrom", "Opens from", [
                  ["bottom", "Bottom"],
                  ["right", "Right"],
                  ["fade", "Fade in"],
                ])}
                {text("header", "Header text", "", true)}
                {fontUpload.select}
              </div>
              {fontUpload.box}
              {box("popup.logo", "Show my logo in the popup")}
              {box(
                "popup.sticky",
                "Keep the table header and close button visible while scrolling",
              )}
              {box("popup.rtl", "Right-to-left layout for Arabic and Hebrew")}
              {box("popup.fitOnly", "Show only the Find my size link")}
            </section>

            <section className="card" aria-labelledby="h-where">
              <h2 id="h-where">Where it shows</h2>
              {box(
                "placement.productBlock",
                "Product page, next to the size picker",
                <>
                  Add or move the Fitted block in your theme editor.{" "}
                  {/* A new tab: the save bar holds this one while edits are unsaved. */}
                  <a href={props.themeUrl} target="_blank" rel="noreferrer">
                    Open theme editor
                  </a>
                </>,
              )}
              {box(
                "placement.quickView",
                "Collection pages and quick view",
                "Shoppers can check sizing before opening a product.",
              )}
              {box(
                "placement.floatingTab",
                "Floating tab on every product page",
                "Stays at the edge of the screen while shoppers scroll.",
              )}
              {box(
                "placement.featured",
                "Featured product sections",
                "Show the size guide wherever your theme features a product.",
              )}
              {text(
                "placement.selector",
                "Advanced: place after this element",
                "A CSS selector from your theme. Leave empty to use the app block.",
              )}
            </section>

            <section className="card" aria-labelledby="h-look">
              <h2 id="h-look">Colors and fonts</h2>
              {[
                [
                  "theme",
                  "Match my theme",
                  "Uses your theme's fonts and colors. Recommended.",
                ],
                ["custom", "Custom", ""],
              ].map(([v, label, help]) => (
                <label key={v} className="choice">
                  <input
                    type="radio"
                    name="colors.mode"
                    checked={draft["colors.mode"] === v}
                    onChange={() => put("colors.mode", v)}
                  />
                  <span>
                    <strong>{label}</strong>
                    {help && <span className="help">{help}</span>}
                  </span>
                </label>
              ))}
              <div className="fields colors">
                {(["text", "accent", "background"] as const).map(color)}
                {Object.keys(NAMES).map((k) => err(`colors.${k}`))}
              </div>
            </section>

            <section className="card" aria-labelledby="h-units">
              <h2 id="h-units">Units</h2>
              <div>
                {select("units.default", "Default unit", [
                  ["country", "Pick by shopper's country"],
                  ["in", "Always inches"],
                  ["cm", "Always centimeters"],
                ])}
                <p className="help">
                  Inches in the US, Liberia and Myanmar; centimeters everywhere
                  else.
                </p>
              </div>
              {box(
                "units.toggle",
                "Let shoppers switch between in and cm",
                null,
              )}
            </section>

            <section className="card" aria-labelledby="h-adv">
              <h2 id="h-adv">Advanced</h2>
              {text(
                "css",
                "Custom CSS",
                "Added as written to every page that shows the size guide: product pages, quick views and featured products. Start each rule with .fitted-guide to style only the size guide.",
              )}
            </section>
          </>
        }
        side={preview}
      />
    </>
  );
}
