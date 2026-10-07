import { describe, expect, it } from "vitest";
import {
  emailImageSources,
  escapeMarkdown,
  renderEmailBodyHtml,
  rewriteEmailImages,
} from "@/modules/communications/email-html";
import { renderMessageTemplate, SAMPLE_MESSAGE_TEMPLATE_CONTEXT } from "@/modules/communications/templates";
import { REGISTRATION_MANAGE_LINK_SENTINEL } from "@/modules/communications/manage-link";

const FILE_ID = "cm9abc123def456";

describe("button links (#824)", () => {
  it("renders a link alone on its line as a table-based button", () => {
    const html = renderEmailBodyHtml("[Open my pass](https://example.test/pass){.button}");
    expect(html).toContain('<table role="presentation"');
    expect(html).toContain('bgcolor="#0f6f8c"');
    expect(html).toContain('mso-padding-alt:12px 24px');
    expect(html).toContain('<a href="https://example.test/pass" target="_blank"');
    expect(html).toContain(">Open my pass</a>");
    expect(html).not.toContain("{.button}");
    expect(html).not.toContain("<p");
  });

  it("renders several buttons and surrounding paragraphs as separate blocks", () => {
    const html = renderEmailBodyHtml("Before.\n[One](https://a.test){.button}\n[Two](https://b.test){.button}\nAfter.");
    expect((html.match(/<table /g) ?? []).length).toBe(2);
    expect(html).toContain('<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#22333b;">Before.</p>');
    expect(html).toContain(">After.</p>");
  });

  it("renders a button inside a sentence as an ordinary link and never shows the marker", () => {
    const html = renderEmailBodyHtml("Please [open this](https://example.test){.button} today.");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("{.button}");
    expect(html).toContain('<a href="https://example.test"');
  });

  it("keeps the same scheme validation as any link: an unsafe destination is neither a button nor a link", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "ftp://example.test/x", "//example.test"]) {
      const html = renderEmailBodyHtml(`[Click](${url}){.button}`);
      expect(html, url).not.toContain("<a ");
      expect(html, url).not.toContain("<table");
      expect(html, url).not.toContain("href=");
      expect(html, url).toContain("Click");
    }
  });

  it("allows mail, phone and the private-link sentinel as destinations", () => {
    expect(renderEmailBodyHtml("[Write](mailto:team@example.test){.button}")).toContain('href="mailto:team@example.test"');
    expect(renderEmailBodyHtml("[Call](tel:+15555550100){.button}")).toContain('href="tel:+15555550100"');
    expect(renderEmailBodyHtml(`[Open](${REGISTRATION_MANAGE_LINK_SENTINEL}){.button}`)).toContain(`href="${REGISTRATION_MANAGE_LINK_SENTINEL}"`);
  });

  it("cannot be injected through the button text or the destination", () => {
    const html = renderEmailBodyHtml('[<script>alert(1)</script>](https://example.test/"onmouseover="x){.button}');
    expect(html).not.toContain("<script");
    expect(html).not.toContain('onmouseover="x"');
    const quoted = renderEmailBodyHtml('[Go "now" & <b>](https://example.test/a?b=1&c=2){.button}');
    expect(quoted).toContain("Go &quot;now&quot; &amp; &lt;b&gt;");
    expect(quoted).toContain('href="https://example.test/a?b=1&amp;c=2"');
  });

  it("never turns a registrant-supplied value into a button, a link or an image", () => {
    const trap = "[Pay now](https://malicious.example){.button}";
    const rendered = renderMessageTemplate(
      { subject: "Hi", body: "Dear {{recipient_name}},\n\n{{recipient_name}}\n\nThanks." },
      { ...SAMPLE_MESSAGE_TEMPLATE_CONTEXT, recipient_name: trap },
    );
    expect(rendered.bodyHtml).not.toContain("<table");
    expect(rendered.bodyHtml).not.toContain("<a ");
    expect(rendered.bodyHtml).not.toContain("href=");
    expect(rendered.bodyHtml).toContain("[Pay now](https://malicious.example){.button}");
    // The text part shows the value exactly as supplied, without an escape.
    expect(rendered.body).toContain(trap);

    const image = renderMessageTemplate(
      { subject: "Hi", body: "{{recipient_name}}" },
      { ...SAMPLE_MESSAGE_TEMPLATE_CONTEXT, recipient_name: `![x](msgfile:${FILE_ID})` },
    );
    expect(image.bodyHtml).not.toContain("<img");
    // An escaped marker typed straight into a token value stays literal text, too.
    expect(renderEmailBodyHtml(escapeMarkdown("[a](https://b.test){.button}"))).not.toContain("<table");
  });
});

describe("uploaded images (#824)", () => {
  it("accepts msgfile: only on an image, only in its generated-id shape", () => {
    expect(renderEmailBodyHtml(`![Map](msgfile:${FILE_ID})`)).toContain(`<img src="msgfile:${FILE_ID}" alt="Map"`);
    // As a link, the scheme is not allowed: it is just the text.
    const asLink = renderEmailBodyHtml(`[Map](msgfile:${FILE_ID})`);
    expect(asLink).not.toContain("<a ");
    expect(asLink).not.toContain("msgfile:");
    // Anything but the exact shape is dropped to its description.
    for (const bad of ["msgfile:", "msgfile:../../etc/passwd", "msgfile:a", "msgfile:cm9abc123def456/x", "MSGFILE:cm9abc123def456"]) {
      expect(renderEmailBodyHtml(`![Map](${bad})`), bad).not.toContain("<img");
    }
  });

  it("keeps the description as alt text", () => {
    const html = renderEmailBodyHtml(`![A "quoted" map & key](msgfile:${FILE_ID})`);
    expect(html).toContain('alt="A &quot;quoted&quot; map &amp; key"');
  });

  it("rewrites an uploaded image to its cid: part and leaves the others alone", () => {
    const html = renderEmailBodyHtml(`![Map](msgfile:${FILE_ID})\n\n![Remote](https://example.test/a.png)`);
    expect(emailImageSources(html)).toEqual([`msgfile:${FILE_ID}`, "https://example.test/a.png"]);
    const rewritten = rewriteEmailImages(html, (src) => (src.startsWith("msgfile:") ? { src: "cid:abc@imsda-events" } : null));
    expect(rewritten).toContain('<img src="cid:abc@imsda-events" alt="Map"');
    expect(rewritten).toContain('<img src="https://example.test/a.png" alt="Remote"');
    expect(rewritten).not.toContain("msgfile:");
  });

  it("replaces an image that cannot be embedded with its description", () => {
    const html = renderEmailBodyHtml(`![Map of the grounds](msgfile:${FILE_ID})`);
    const dropped = rewriteEmailImages(html, () => ({ drop: true }));
    expect(dropped).toContain("Map of the grounds");
    expect(dropped).not.toContain("<img");
  });

  it("only rewrites the exact tags the renderer produced", () => {
    const foreign = '<img src="msgfile:x" onerror="x" />';
    expect(rewriteEmailImages(foreign, () => ({ src: "cid:y" }))).toBe(foreign);
  });
});

describe("a heading over an empty seminar list (#824 leftover)", () => {
  const body = "Hello.\n\n### Your seminars\n\n{{seminar_preferences}}\n\n### Your check-in codes\n\nShow it at the door.";

  it("drops the heading directly above the token when it renders empty", () => {
    const rendered = renderMessageTemplate({ subject: "S", body }, { ...SAMPLE_MESSAGE_TEMPLATE_CONTEXT, seminar_preferences: "" });
    expect(rendered.body).not.toContain("Your seminars");
    expect(rendered.bodyHtml).not.toContain("Your seminars");
    expect(rendered.body).toBe("Hello.\n\n### Your check-in codes\n\nShow it at the door.");
    expect(rendered.bodyHtml).toContain("Your check-in codes");
  });

  it("drops it with no blank line between heading and token, and leaves other headings alone", () => {
    const rendered = renderMessageTemplate(
      { subject: "S", body: "## Seminars\n{{seminar_preferences}}\n\n## Schedule\n\nFriday." },
      { ...SAMPLE_MESSAGE_TEMPLATE_CONTEXT, seminar_preferences: "" },
    );
    expect(rendered.body).toBe("## Schedule\n\nFriday.");
  });

  it("keeps the heading when the list has content", () => {
    const rendered = renderMessageTemplate({ subject: "S", body }, { ...SAMPLE_MESSAGE_TEMPLATE_CONTEXT, seminar_preferences: "Ann\n- 1st choice: Prayer" });
    expect(rendered.body).toContain("### Your seminars");
  });

  it("does not take a heading that is not directly above the token", () => {
    const rendered = renderMessageTemplate(
      { subject: "S", body: "### Your seminars\n\nSee below.\n\n{{seminar_preferences}}" },
      { ...SAMPLE_MESSAGE_TEMPLATE_CONTEXT, seminar_preferences: "" },
    );
    expect(rendered.body).toContain("### Your seminars");
  });
});
