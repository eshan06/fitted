import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as privacy from "./privacy";
import * as support from "./support";

// The owner fills these in before launch (#48); a new one goes on #47's list.
const placeholders = [
  "[EFFECTIVE DATE]",
  "[LEGAL NAME]",
  "[CONTACT ADDRESS]",
  "[SUPPORT EMAIL]",
  "[HOSTING REGION]",
  "[LOG RETENTION]",
  "[RESPONSE TIME]",
];

const text = (page: typeof privacy | typeof support) =>
  renderToStaticMarkup(<page.default />)
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe.each([
  ["privacy", privacy, "/support"],
  ["support", support, "/privacy"],
])("public %s page", (_name, page, otherPage) => {
  it("is public: no loader or action, so it reads no shop's data", () => {
    expect(page).not.toHaveProperty("loader");
    expect(page).not.toHaveProperty("action");
  });

  it("has a title, one h1, a main landmark and a link to the other page", () => {
    const html = renderToStaticMarkup(<page.default />);
    expect(page.meta({} as never)).toContainEqual(
      expect.objectContaining({ title: expect.stringContaining("Fitted") }),
    );
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain("<main");
    expect(html).toContain(`href="${otherPage}"`);
  });

  it("uses only the listed placeholders", () => {
    const found = text(page).match(/\[[A-Z][A-Z ]*\]/g) ?? [];
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) expect(placeholders).toContain(p);
  });
});

describe("privacy policy", () => {
  const policy = text(privacy);

  it("states the retention periods the app enforces (ARCHITECTURE §13, §14)", () => {
    expect(policy).toContain("Size guide events 90 days");
    expect(policy).toContain("Daily AI reading counts 30 days");
    expect(policy).toContain("The last 30 versions of each chart");
    expect(policy).toContain("older ones for 7 days");
    expect(policy).toContain("About 48 hours later");
  });

  it("names every service that receives data and what it gets", () => {
    for (const name of ["Shopify", "Railway", "OpenAI"])
      expect(policy).toContain(name);
    expect(policy).toContain("never shopper data");
  });

  it("says fit finder answers never leave the browser (§10)", () => {
    expect(policy).toContain("are never sent to us or anyone else");
    expect(policy).toContain("Fitted stores no personal data about shoppers");
  });

  it("lists every placeholder a contact section needs", () => {
    for (const p of ["[LEGAL NAME]", "[CONTACT ADDRESS]", "[SUPPORT EMAIL]"])
      expect(policy).toContain(p);
  });
});

describe("support page", () => {
  it("gives the support email", () => {
    expect(text(support)).toContain("[SUPPORT EMAIL]");
  });
});
