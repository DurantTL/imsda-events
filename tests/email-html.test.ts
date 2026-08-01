import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  escapeMarkdown,
  renderEmailBodyHtml,
  renderEmailHtmlDocument,
} from "@/modules/communications/email-html";

describe("email HTML rendering", () => {
  it("escapes the whole source before it looks for markup", () => {
    expect(escapeHtml(`<script>alert("x") & 'y'</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;",
    );
  });

  /**
   * The one property that matters most: token values carry registrant-submitted
   * text — names, form answers, announcement bodies — and none of it may become
   * markup once it lands in a body.
   */
  it("never emits a tag from registrant-submitted token text", () => {
    const html = renderEmailBodyHtml(
      'Hello <img src=x onerror="alert(1)">, <b>welcome</b> & good day.',
    );

    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("onerror=\"alert(1)\"");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&amp; good day.");
  });

  it("renders headings, lists, rules, emphasis, and code", () => {
    const html = renderEmailBodyHtml([
      "# Title",
      "",
      "### Section",
      "",
      "Some **bold** and *italic* and `code`.",
      "",
      "- first",
      "- second",
      "",
      "1. one",
      "",
      "---",
    ].join("\n"));

    expect(html).toContain("<h1");
    expect(html).toContain(">Title</h1>");
    expect(html).toContain("<h3");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code");
    expect(html).toContain("<ul");
    expect(html).toContain("<li style=\"margin:0 0 4px;\">first</li>");
    expect(html).toContain("<ol");
    expect(html).toContain("<hr");
  });

  it("keeps lines of one paragraph together with breaks rather than new paragraphs", () => {
    const html = renderEmailBodyHtml("First line\nSecond line\n\nNext paragraph");
    expect(html).toContain("First line<br />Second line");
    expect((html.match(/<p /g) ?? []).length).toBe(2);
  });

  it("links only web, mail, and telephone schemes and keeps other text inert", () => {
    const html = renderEmailBodyHtml([
      "[Portal](https://events.example.test/manage/abc)",
      "",
      "[Mail](mailto:office@example.test)",
      "",
      "[Bad](javascript:alert)",
      "",
      "[Data](data:text/html;base64,PHNjcmlwdD4=)",
    ].join("\n"));

    expect(html).toContain('<a href="https://events.example.test/manage/abc"');
    expect(html).toContain('<a href="mailto:office@example.test"');
    // No rejected scheme ever reaches an attribute, and no second anchor exists
    // beyond the two allowed ones.
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect((html.match(/<a href=/g) ?? []).length).toBe(2);
    // The rejected links keep their text so the sentence still reads.
    expect(html).toContain("Bad");
    expect(html).toContain("Data");
  });

  it("renders images only for web URLs and always with an alt", () => {
    const good = renderEmailBodyHtml("![Check-in QR code](https://events.example.test/qr.png)");
    expect(good).toContain('<img src="https://events.example.test/qr.png"');
    expect(good).toContain('alt="Check-in QR code"');

    const bad = renderEmailBodyHtml("![Nope](javascript:alert(1))");
    expect(bad).not.toContain("<img");
    expect(bad).toContain("Nope");
  });

  it("autolinks a bare portal URL so a plain-text template still gets a link", () => {
    const html = renderEmailBodyHtml("Open https://events.example.test/manage/abc to continue.");
    expect(html).toContain('<a href="https://events.example.test/manage/abc"');
  });

  it("drops a backslash escape and renders the character literally", () => {
    const html = renderEmailBodyHtml("A literal \\*star\\* and \\[bracket\\].");

    expect(html).toContain("A literal *star* and [bracket].");
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("\\");
  });

  it("escapes every Markdown construct in an untrusted value", () => {
    const escaped = escapeMarkdown("[Review your registration](https://malicious.example)");
    const html = renderEmailBodyHtml(`Hello ${escaped},`);

    expect(html).not.toContain("<a href=");
    expect(html).toContain("[Review your registration](https://malicious.example)");
  });

  it("keeps a heading, list, and emphasis inert inside an escaped value", () => {
    const escaped = escapeMarkdown("# Heading\n- item\n**bold** _italic_ `code`");
    const html = renderEmailBodyHtml(escaped);

    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("<code");
    expect(html).toContain("# Heading");
    expect(html).toContain("**bold**");
  });

  it("keeps an escaped image from fetching a remote tracking pixel", () => {
    const escaped = escapeMarkdown("![](https://malicious.example/pixel.gif)");
    expect(renderEmailBodyHtml(escaped)).not.toContain("<img");
  });

  /**
   * A marker in the input would otherwise be restored as somebody else's
   * escaped character, which is a way to smuggle one back out.
   */
  it("strips a literal marker character supplied in the source", () => {
    const html = renderEmailBodyHtml(`a\u00010\u0001b \\*star\\*`);
    // The marker characters are gone; only their real content survives, and the
    // genuine escape still resolves to its own character rather than to whatever
    // a forged marker pointed at.
    expect(html).toContain("a0b");
    expect(html).not.toContain(String.fromCharCode(1));
    expect(html).toContain("*star*");
    expect(html).not.toContain("<em>");
  });

  it("wraps a body in a complete document with an escaped title", () => {
    const document = renderEmailHtmlDocument({
      title: 'Registration confirmed <"Women\'s Retreat">',
      body: "# Hello",
      footer: "IMSDA Events",
    });

    expect(document.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(document).toContain("</html>");
    expect(document).toContain("&lt;&quot;Women&#39;s Retreat&quot;&gt;");
    expect(document).not.toMatch(/<title>[^<]*<"/);
    expect(document).toContain("IMSDA Events");
  });

  it("produces a document for an empty body rather than failing", () => {
    expect(renderEmailHtmlDocument({ title: "Empty", body: "" })).toContain("</html>");
    expect(renderEmailHtmlDocument({ title: "Empty" })).toContain("</html>");
  });

  it("wraps an already-rendered fragment without re-parsing it as Markdown", () => {
    const document = renderEmailHtmlDocument({
      title: "Prerendered",
      bodyHtml: "<p>Already <strong>rendered</strong> **not bold**</p>",
    });

    expect(document).toContain("<p>Already <strong>rendered</strong> **not bold**</p>");
  });
});
