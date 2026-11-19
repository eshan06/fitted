import { Suspense, useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Await,
  data,
  useFetcher,
  useLoaderData,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import {
  SECTIONS,
  SettingsConflictError,
  SettingsValidationError,
  getSettings,
  isBool,
  saveSettings,
} from "../models/settings.server";
import type { Loaded } from "../models/settings.server";

// Appearance & languages: the Appearance board on the Fitted canvas.
// Languages (#43), the font upload and the live preview (#65) come later.

const log = (msg: string, shop: string, error: unknown) =>
  console.log(
    JSON.stringify({
      level: "error",
      msg,
      shop,
      route: "app.appearance",
      error: String(error),
    }),
  );

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  // Not awaited, so the page shows its loading state while Shopify answers.
  const appearance = getSettings(admin).catch((error): Loaded | null => {
    log("Appearance settings didn't load", session.shop, error);
    return null;
  });
  return { appearance };
};

// Only the fields this screen edits; the rest (fit finder, other languages) stays as stored.
const FORM_SECTIONS = ["link", "popup", "placement", "units"] as const;
function fromForm(form: FormData, { settings, primaryLocale }: Loaded) {
  const next: Record<string, unknown> = { ...settings };
  for (const section of FORM_SECTIONS) {
    const out: Record<string, unknown> = { ...settings[section] };
    for (const [field, check] of Object.entries(SECTIONS[section])) {
      const name = `${section}.${field}`;
      if (isBool(check)) out[field] = form.has(name);
      else if (form.has(name)) out[field] = form.get(name);
    }
    next[section] = out;
  }
  next.colors =
    form.get("colors.mode") === "custom"
      ? {
          mode: "custom",
          text: form.get("colors.text"),
          accent: form.get("colors.accent"),
          background: form.get("colors.background"),
        }
      : { mode: form.get("colors.mode") };
  next.css = form.get("css");
  next.text = {
    ...settings.text,
    [primaryLocale]: {
      ...settings.text[primaryLocale],
      label: form.get(`text.${primaryLocale}.label`),
      header: form.get(`text.${primaryLocale}.header`),
    },
  };
  return next;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const digest = form.get("digest");
  try {
    const loaded = await getSettings(admin);
    // The digest the screen loaded, so a save over a newer one is refused.
    await saveSettings(
      admin,
      {
        ...loaded,
        digest: typeof digest === "string" && digest ? digest : null,
      },
      fromForm(form, loaded),
    );
    return { ok: true as const };
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof SettingsValidationError)
      return data({ fieldErrors: error.fieldErrors }, { status: 422 });
    if (error instanceof SettingsConflictError)
      return data(
        {
          error: {
            code: "conflict",
            message: "Settings changed since they loaded",
          },
        },
        { status: 409 },
      );
    log("Appearance settings didn't save", session.shop, error);
    return data(
      {
        error: { code: "shopify", message: "Shopify didn't save the settings" },
      },
      { status: 502 },
    );
  }
};

export default function Appearance() {
  const { appearance } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Appearance & languages">
      <s-stack gap="base">
        <s-paragraph color="subdued">
          Make the size guide look like part of your store.
        </s-paragraph>
        <Suspense fallback={<Loading />}>
          <Await resolve={appearance}>
            {(loaded) =>
              loaded ? (
                <Editor key={loaded.digest ?? "new"} loaded={loaded} />
              ) : (
                <LoadError />
              )
            }
          </Await>
        </Suspense>
      </s-stack>
    </s-page>
  );
}

function Loading() {
  type Size = `${number}px` | `${number}%`;
  const bar = (inlineSize: Size, blockSize: Size = "12px") => (
    <s-box
      background="strong"
      borderRadius="base"
      inlineSize={inlineSize}
      blockSize={blockSize}
    ></s-box>
  );
  return (
    <s-stack gap="base">
      <s-text accessibilityVisibility="exclusive">
        Loading appearance settings
      </s-text>
      {[3, 6, 4].map((rows, i) => (
        <s-section key={i}>
          <s-stack gap="base">
            {bar("140px", "16px")}
            {Array.from({ length: rows - 1 }, (_, r) => (
              <s-box key={r}>{bar(`${75 - r * 7}%`)}</s-box>
            ))}
          </s-stack>
        </s-section>
      ))}
    </s-stack>
  );
}

function LoadError() {
  const { revalidate, state } = useRevalidator();
  return (
    <s-banner tone="critical" heading="Your appearance settings didn't load">
      Fitted couldn&apos;t reach your store just now. Shoppers still see your
      size guide as it was.
      <s-button
        slot="secondary-actions"
        onClick={() => revalidate()}
        loading={state === "loading" || undefined}
      >
        Try again
      </s-button>
    </s-banner>
  );
}

// React 18 writes `false` as the attribute "false", which a web component reads as set.
const on = (value: boolean) => value || undefined;

function Editor({ loaded }: { loaded: Loaded }) {
  const fetcher = useFetcher<typeof action>();
  const form = useRef<HTMLFormElement>(null);
  const { settings: s, primaryLocale } = loaded;
  const text = s.text[primaryLocale];
  const result = fetcher.state === "idle" ? fetcher.data : undefined;
  const errors: Record<string, string> =
    (result && "fieldErrors" in result && result.fieldErrors) || {};
  const failed =
    result && "error" in result
      ? result.error.code
      : Object.keys(errors).length
        ? "invalid"
        : null;
  const custom = s.colors.mode === "custom" ? s.colors : null;
  const choices = (value: string, options: [string, string][]) =>
    options.map(([v, label]) => (
      <s-choice key={v} value={v} selected={on(v === value)}>
        {label}
      </s-choice>
    ));
  const options = (options: [string, string][]) =>
    options.map(([v, label]) => (
      <s-option key={v} value={v}>
        {label}
      </s-option>
    ));
  const box = (
    path: string,
    label: string,
    checked: boolean,
    details?: string,
  ) => (
    <s-checkbox
      name={path}
      value="true"
      label={label}
      details={details}
      checked={on(checked)}
      error={errors[path]}
    ></s-checkbox>
  );

  return (
    <form
      ref={form}
      data-save-bar
      onSubmit={(event) => {
        event.preventDefault();
        fetcher.submit(event.currentTarget, { method: "post" });
      }}
    >
      <input type="hidden" name="digest" value={loaded.digest ?? ""} />
      <s-stack gap="base">
        {failed && (
          <s-banner
            tone="critical"
            heading="Your appearance changes weren't saved"
          >
            {failed === "conflict"
              ? "Someone saved these settings in another tab since you opened this page, so shoppers see their version. Reload to get it, then make your changes again."
              : failed === "invalid"
                ? "Fix the fields marked below, then save again. Shoppers still see the size guide as it was."
                : "Shopify didn't respond in time, so shoppers still see the size guide as it was. Your edits are still here."}
            {failed === "conflict" ? (
              <s-button
                slot="secondary-actions"
                onClick={() => window.location.reload()}
              >
                Reload
              </s-button>
            ) : failed === "shopify" ? (
              <s-button
                slot="secondary-actions"
                onClick={() => form.current?.requestSubmit()}
              >
                Try saving again
              </s-button>
            ) : null}
          </s-banner>
        )}

        <s-section heading="Size guide link">
          <s-stack gap="base">
            <s-choice-list
              label="Style"
              name="link.style"
              error={errors["link.style"]}
            >
              {choices(s.link.style, [
                ["text", "Text link"],
                ["button", "Button"],
                ["tab", "Floating tab"],
              ])}
            </s-choice-list>
            <s-grid gridTemplateColumns="2fr 1fr" gap="base">
              <s-text-field
                label="Label"
                name={`text.${primaryLocale}.label`}
                value={text.label}
                error={errors[`text.${primaryLocale}.label`]}
              ></s-text-field>
              <s-select
                label="Icon"
                name="link.icon"
                value={s.link.icon}
                error={errors["link.icon"]}
              >
                {options([
                  ["ruler", "Ruler"],
                  ["hanger", "Hanger"],
                  ["tape", "Tape measure"],
                  ["none", "None"],
                ])}
              </s-select>
            </s-grid>
          </s-stack>
        </s-section>

        <s-section heading="Popup">
          <s-stack gap="base">
            <s-choice-list
              label="Style"
              name="popup.style"
              error={errors["popup.style"]}
            >
              {choices(s.popup.style, [
                ["center", "Centered"],
                ["drawer", "Side drawer"],
              ])}
            </s-choice-list>
            {box(
              "popup.sheetOnPhone",
              "Open as a bottom sheet on phones",
              s.popup.sheetOnPhone,
            )}
            <s-grid gridTemplateColumns="1fr 2fr" gap="base">
              <s-select
                label="Opens from"
                name="popup.openFrom"
                value={s.popup.openFrom}
                error={errors["popup.openFrom"]}
              >
                {options([
                  ["bottom", "Bottom"],
                  ["right", "Right"],
                  ["fade", "Fade in"],
                ])}
              </s-select>
              <s-text-field
                label="Header text"
                name={`text.${primaryLocale}.header`}
                value={text.header}
                error={errors[`text.${primaryLocale}.header`]}
              ></s-text-field>
            </s-grid>
            {box("popup.logo", "Show my logo in the popup", s.popup.logo)}
            {box(
              "popup.sticky",
              "Keep the table header and close button visible while scrolling",
              s.popup.sticky,
            )}
            {box(
              "popup.rtl",
              "Right-to-left layout for Arabic and Hebrew",
              s.popup.rtl,
            )}
            {box(
              "popup.fitOnly",
              "Show only the Find my size link",
              s.popup.fitOnly,
            )}
          </s-stack>
        </s-section>

        <s-section heading="Where it shows">
          <s-stack gap="base">
            <s-stack gap="small-200">
              {box(
                "placement.productBlock",
                "Product page, next to the size picker",
                s.placement.productBlock,
                "Add or move the Fitted block in your theme editor.",
              )}
              <s-link
                href="shopify://admin/themes/current/editor?template=product"
                target="_top"
              >
                Open theme editor
              </s-link>
            </s-stack>
            {box(
              "placement.quickView",
              "Collection pages and quick view",
              s.placement.quickView,
              "Shoppers can check sizing before opening a product.",
            )}
            {box(
              "placement.floatingTab",
              "Floating tab on every product page",
              s.placement.floatingTab,
              "Stays at the edge of the screen while shoppers scroll.",
            )}
            {box(
              "placement.featured",
              "Featured product sections",
              s.placement.featured,
              "Show the size guide wherever your theme features a product.",
            )}
            <s-text-field
              label="Advanced: place after this element"
              name="placement.selector"
              value={s.placement.selector}
              details="A CSS selector from your theme. Leave empty to use the app block."
              error={errors["placement.selector"]}
            ></s-text-field>
          </s-stack>
        </s-section>

        <s-section heading="Colors and fonts">
          <s-stack gap="base">
            <s-choice-list
              label="Colors"
              labelAccessibilityVisibility="exclusive"
              name="colors.mode"
              error={errors["colors.mode"]}
            >
              <s-choice value="theme" selected={on(!custom)}>
                Match my theme
                <s-text slot="details">
                  Uses your theme&apos;s fonts and colors. Recommended.
                </s-text>
              </s-choice>
              <s-choice value="custom" selected={on(!!custom)}>
                Custom
              </s-choice>
            </s-choice-list>
            <s-grid
              gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))"
              gap="base"
            >
              {(
                [
                  ["text", "Text", "#202223"],
                  ["accent", "Accent", "#2448A8"],
                  ["background", "Background", "#FFFFFF"],
                ] as const
              ).map(([key, label, fallback]) => (
                <s-color-field
                  key={key}
                  label={label}
                  name={`colors.${key}`}
                  value={custom?.[key] ?? fallback}
                  error={errors[`colors.${key}`]}
                ></s-color-field>
              ))}
            </s-grid>
          </s-stack>
        </s-section>

        <s-section heading="Units">
          <s-stack gap="base">
            <s-select
              label="Default unit"
              name="units.default"
              value={s.units.default}
              details="Inches in the US, Liberia and Myanmar; centimeters everywhere else."
              error={errors["units.default"]}
            >
              {options([
                ["country", "Pick by shopper's country"],
                ["in", "Always inches"],
                ["cm", "Always centimeters"],
              ])}
            </s-select>
            {box(
              "units.toggle",
              "Let shoppers switch between in and cm",
              s.units.toggle,
            )}
          </s-stack>
        </s-section>

        <s-section heading="Advanced">
          <s-text-area
            label="Custom CSS"
            name="css"
            rows={3}
            value={s.css}
            details="Applies only to the size guide. Fitted never runs custom code on your checkout."
            error={errors.css}
          ></s-text-area>
        </s-section>
      </s-stack>
    </form>
  );
}
