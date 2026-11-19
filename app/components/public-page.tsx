import type { ReactNode } from "react";

// The layout for Fitted's public pages (privacy, support): plain, readable on a
// phone, light and dark. They sit outside the embedded admin with no shop session,
// so they take no loader and show no shop's data (ARCHITECTURE §2).
const css = `
:root { color-scheme: light dark; }
body { margin: 0; background: Canvas; color: CanvasText; }
.public-page { box-sizing: border-box; max-width: 42rem; margin: 0 auto; padding: 2rem 1rem 4rem;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 1.0625rem; line-height: 1.6; overflow-wrap: break-word; }
.public-page h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 0.5rem; }
.public-page h2 { font-size: 1.375rem; line-height: 1.3; margin: 2.25rem 0 0.5rem; }
.public-page h3 { font-size: 1.125rem; margin: 1.5rem 0 0.25rem; }
.public-page a { color: LinkText; text-decoration: underline; }
.public-page ul { padding-left: 1.25rem; }
.public-page li + li { margin-top: 0.25rem; }
.public-page .table-wrap { overflow-x: auto; }
.public-page table { border-collapse: collapse; width: 100%; }
.public-page th, .public-page td { text-align: left; vertical-align: top; padding: 0.5rem; border-bottom: 1px solid GrayText; }
.public-page footer { margin-top: 3rem; }
`;

export function PublicPage({ children }: { children: ReactNode }) {
  return (
    <>
      <style>{css}</style>
      <main className="public-page">{children}</main>
    </>
  );
}
