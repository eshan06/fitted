// The size guide's styles (ARCHITECTURE §9), from the Storefront and
// GuideStates boards. The loader adds css once, so nothing render-blocking
// lands in the theme's <head>; render adds tableCss with the tabs it draws,
// so loader.js carries only what the link, the popup and its loading and error
// states need. The admin preview (#23) can add the same strings. The loader
// sets the three colors and the font on .fitted-guide from the Appearance
// settings (§7); the other shades mix from them. A browser without
// color-mix() (Safari before 16.2) drops those shades: lines, tint and the
// alert's fill go, and text keeps the main color, so every color still reads.
// PURE lets each bundle drop the string it doesn't use.
export const css = /* @__PURE__ */ [
  ".fitted-guide{--fitted-bg:#fff;--fitted-text:#161616;--fitted-accent:#2448a8}",
  ".fitted-link{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 2px;border:0;background:none;color:inherit;font:inherit;font-weight:600;text-decoration:underline;text-underline-offset:4px;cursor:pointer}",
  ".fitted-dialog{--fitted-muted:color-mix(in srgb,var(--fitted-text) 84%,var(--fitted-bg));--fitted-line:color-mix(in srgb,var(--fitted-text) 16%,var(--fitted-bg));--fitted-faint:color-mix(in srgb,var(--fitted-text) 10%,var(--fitted-bg));--fitted-tint:color-mix(in srgb,var(--fitted-accent) 10%,var(--fitted-bg));--fitted-alert:color-mix(in srgb,#d72c0d 8%,var(--fitted-bg));--fitted-alert-line:color-mix(in srgb,#d72c0d 40%,var(--fitted-bg));box-sizing:border-box;width:calc(100% - 32px);max-width:640px;max-height:calc(100% - 80px);margin:40px auto auto;padding:0;border:0;border-radius:0;background:var(--fitted-bg);color:var(--fitted-text);font-family:var(--fitted-font);box-shadow:0 24px 64px rgba(0,0,0,.28);overflow:auto;text-align:start;line-height:1.5}",
  ".fitted-dialog::backdrop{background:rgba(22,22,22,.55)}",
  "html:has(.fitted-dialog[open]){overflow:hidden}",
  ".fitted-dialog *{box-sizing:border-box}",
  ".fitted-dialog [hidden]{display:none!important}",
  ".fitted-dialog :focus-visible{outline:2px solid var(--fitted-accent);outline-offset:2px}",
  ".fitted-panel{display:flex;flex-direction:column;gap:18px;padding:28px 32px}",
  ".fitted-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}",
  ".fitted-body{display:flex;flex-direction:column;gap:14px}",
  ".fitted-dialog .fitted-title{margin:0;font-size:28px;font-weight:600;letter-spacing:-.01em;line-height:1.2}",
  ".fitted-dialog .fitted-sub{margin:4px 0 0;font-size:15px;color:var(--fitted-muted)}",
  ".fitted-dialog .fitted-h3{margin:0;font-size:20px;font-weight:600;line-height:1.3}",
  ".fitted-dialog .fitted-note{margin:0;font-size:14px;color:var(--fitted-muted);white-space:pre-line}",
  ".fitted-dialog button{font:inherit;cursor:pointer}",
  ".fitted-dialog .fitted-x{display:inline-flex;flex:none;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:1px solid currentColor;border-radius:2px;background:var(--fitted-bg);color:inherit}",
  ".fitted-dialog .fitted-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border:1px solid var(--fitted-accent);border-radius:2px;background:var(--fitted-accent);color:var(--fitted-bg);font-size:15px;font-weight:600}",
  ".fitted-dialog .fitted-ghost{border-color:currentColor;background:var(--fitted-bg);color:inherit}",
  ".fitted-alert{display:flex;flex-direction:column;gap:14px;padding:18px;border:1px solid var(--fitted-alert-line);border-radius:2px;background:var(--fitted-alert)}",
  ".fitted-alert p{margin:0;font-size:15px;line-height:1.6}",
  ".fitted-actions{display:flex;flex-wrap:wrap;gap:12px}",
  ".fitted-alert .fitted-help{font-size:13px;line-height:1.5;color:var(--fitted-muted)}",
  ".fitted-help a{color:var(--fitted-accent);text-underline-offset:3px}",
  ".fitted-sk{display:block;height:12px;background:var(--fitted-faint)}",
  ".fitted-skrow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;padding:14px 12px;border-bottom:1px solid var(--fitted-faint)}",
  // Phones: a bottom sheet, with full-width error buttons below the contact line.
  "@media (max-width:600px){",
  ".fitted-dialog{width:100%;max-width:none;max-height:92vh;max-height:92dvh;margin:auto 0 0;border-radius:14px 14px 0 0}",
  ".fitted-panel{gap:14px;padding:18px 16px}",
  ".fitted-actions{flex-direction:column;order:1}",
  "}",
].join("");

export const tableCss = /* @__PURE__ */ [
  ".fitted-scroll{overflow-x:auto}",
  ".fitted-table{width:100%;min-width:420px;margin:0;border-collapse:collapse;font-size:15px;font-variant-numeric:tabular-nums}",
  ".fitted-table th,.fitted-table td{padding:7px 12px;border:0;border-bottom:1px solid var(--fitted-line);background:none;color:inherit;font-weight:inherit;text-align:start;vertical-align:middle;white-space:nowrap}",
  ".fitted-table thead th{padding-top:10px;padding-bottom:10px;border-top:2px solid var(--fitted-text);border-bottom-color:var(--fitted-text);font-size:13px;font-weight:600}",
  ".fitted-table tbody th{font-weight:600}",
  ".fitted-table .fitted-wrap{white-space:normal}",
  ".fitted-table tr[data-fitted-size]{cursor:pointer}",
  ".fitted-table .fitted-on>*,.fitted-table .fitted-lit{background:var(--fitted-tint);color:var(--fitted-accent);font-weight:600}",
  ".fitted-dialog .fitted-pick{padding:4px 0;border:0;background:none;color:inherit;font-weight:inherit;text-align:inherit;text-decoration:underline dotted;text-underline-offset:4px}",
  ".fitted-part{display:contents}",
  // The US/UK/EU/AU and in/cm switches.
  ".fitted-bar{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:12px}",
  ".fitted-seg{display:inline-flex;border:1px solid var(--fitted-text);border-radius:2px}",
  ".fitted-dialog .fitted-seg button{min-width:48px;min-height:34px;padding:0 12px;border:0;border-radius:0;background:var(--fitted-bg);color:var(--fitted-text);font-size:14px;font-weight:600}",
  ".fitted-dialog .fitted-seg [aria-pressed=true]{background:var(--fitted-text);color:var(--fitted-bg)}",
  // The footer stays at the bottom of the guide as the tables scroll.
  ".fitted-foot{position:sticky;bottom:0;z-index:1;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin-bottom:-28px;padding:16px 0 28px;border-top:2px solid var(--fitted-text);background:var(--fitted-bg)}",
  ".fitted-foot strong{font-size:16px;font-weight:600}",
  ".fitted-foot strong span{color:var(--fitted-accent)}",
  ".fitted-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
  // The tabs, then Find my size (§10): its questions and the result.
  ".fitted-tabs{display:flex;flex-wrap:wrap;border-bottom:1px solid var(--fitted-line)}",
  ".fitted-dialog .fitted-tabs button{min-height:44px;margin-right:20px;padding:0 2px;border:0;border-bottom:2px solid transparent;border-radius:0;background:none;color:var(--fitted-muted);font-size:15px;font-weight:500}",
  ".fitted-dialog .fitted-tabs [aria-pressed=true]{border-bottom-color:var(--fitted-text);color:var(--fitted-text);font-weight:600}",
  ".fitted-fit{--fitted-edge:color-mix(in srgb,var(--fitted-text) 62%,var(--fitted-bg));display:flex;flex-wrap:wrap;gap:14px 12px;margin:0}",
  ".fitted-fit>*{flex:1 1 100%}",
  ".fitted-fit>label{display:flex;flex:1 1 160px;flex-direction:column;gap:6px;font-size:14px;font-weight:600}",
  ".fitted-fit input[type=text],.fitted-fit select{width:100%;min-height:44px;margin:0;padding:0 10px;border:1px solid var(--fitted-edge);border-radius:2px;background:var(--fitted-bg);color:var(--fitted-text);font-family:inherit;font-size:15px;font-weight:400}",
  ".fitted-fit fieldset{display:flex;flex-wrap:wrap;gap:8px;min-width:0;margin:0;padding:0;border:0}",
  ".fitted-fit legend{margin-bottom:6px;padding:0;font-size:14px;font-weight:600}",
  ".fitted-opt{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;border:1px solid var(--fitted-edge);border-radius:2px;font-size:15px;cursor:pointer}",
  ".fitted-opt input{margin:0;accent-color:var(--fitted-accent)}",
  ".fitted-dialog .fitted-fine{margin:0;font-size:13px;line-height:1.5;color:var(--fitted-muted)}",
  ".fitted-result{display:flex;flex-direction:column;gap:12px;padding-top:14px;border-top:2px solid var(--fitted-text)}",
  ".fitted-result .fitted-h3 span{color:var(--fitted-accent)}",
  // Phones: tighter tables and tabs, and larger switches.
  "@media (max-width:600px){",
  ".fitted-dialog .fitted-tabs button{margin-right:14px;font-size:14px}",
  ".fitted-table{min-width:0;font-size:14px}",
  ".fitted-table th,.fitted-table td{padding-left:8px;padding-right:8px}",
  ".fitted-bar{justify-content:flex-start}",
  ".fitted-dialog .fitted-seg button{min-width:44px;min-height:44px;padding:0 8px}",
  ".fitted-foot{margin-bottom:-18px;padding-bottom:18px}",
  "}",
].join("");
