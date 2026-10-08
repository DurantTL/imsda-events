import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { HeadingNode } from "@lexical/rich-text";
import { HorizontalRuleNode } from "@lexical/extension";
import { describe, expect, it } from "vitest";
import {
  $exportEmailMarkdown,
  $importEmailMarkdown,
  hasStandaloneCheckinQrUrl,
  isAllowedEmailLinkTarget,
  MessageButtonNode,
  MessageImageNode,
  MessageTokenNode,
} from "@/components/message-body-editor";
import { renderEmailBodyHtml } from "@/modules/communications/email-html";

function loadMarkdown(source: string) {
  const editor = createEditor({
    namespace: "message-body-editor-test",
    nodes: [
      HeadingNode,
      ListNode,
      ListItemNode,
      LinkNode,
      HorizontalRuleNode,
      MessageTokenNode,
      MessageImageNode,
      MessageButtonNode,
    ],
    onError(error) {
      throw error;
    },
  });

  editor.update(() => {
    $importEmailMarkdown(source);
  }, { discrete: true });

  return editor;
}

function exportMarkdown(source: string) {
  return loadMarkdown(source).getEditorState().read(() => $exportEmailMarkdown());
}

describe("message body editor Markdown", () => {
  it("round-trips the formatting supported by the email renderer", () => {
    const source = [
      "# Welcome {{first_name}}",
      "",
      "Use **bold**, *italic*, and `code` with [a link](https://example.test).",
      "",
      "- First item",
      "- Second item",
      "",
      "1. First step",
      "2. Second step",
      "",
      "---",
      "",
      "## See you soon",
    ].join("\n");

    const markdown = exportMarkdown(source);

    expect(exportMarkdown(markdown)).toBe(markdown);
    expect(markdown).toContain("# Welcome {{first_name}}");
    expect(markdown).toContain("**bold**");
    expect(markdown).toContain("[a link](https://example.test)");
    expect(markdown).toContain("---");
    expect(renderEmailBodyHtml(markdown)).toContain("<strong>bold</strong>");
  });

  it("loads template tokens as indivisible text entities", () => {
    const editor = loadMarkdown("Hello {{first_name}}, your balance is {{balance}}.");

    editor.getEditorState().read(() => {
      const tokens = $getRoot()
        .getAllTextNodes()
        .filter((node): node is MessageTokenNode => node instanceof MessageTokenNode);

      expect(tokens.map((node) => node.getTextContent())).toEqual([
        "{{first_name}}",
        "{{balance}}",
      ]);
      expect(tokens.every((node) => node.isToken())).toBe(true);
      expect(tokens.every((node) => !node.canInsertTextBefore())).toBe(true);
      expect(tokens.every((node) => !node.canInsertTextAfter())).toBe(true);
    });
  });

  it("keeps pasted HTML inert when it returns to the production renderer", () => {
    const markdown = exportMarkdown('<img src=x onerror="alert(1)"> {{first_name}}');
    const html = renderEmailBodyHtml(markdown);

    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("onerror=\"alert(1)\"");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markdown).toContain("{{first_name}}");
  });

  it("separates blocks with a blank line so each renders as its own paragraph", () => {
    const markdown = exportMarkdown("First paragraph\n\nSecond paragraph\n\nThird paragraph");

    expect(markdown).toBe("First paragraph\n\nSecond paragraph\n\nThird paragraph");
    expect(exportMarkdown(markdown)).toBe(markdown);
    const html = renderEmailBodyHtml(markdown);
    expect(html.match(/<p /g)).toHaveLength(3);
    expect(html).not.toContain("<br />");
  });

  it("loads bodies saved with single newlines as one paragraph per line and fixes them on re-save", () => {
    const legacy = "Hello {{first_name}}\nArrival is Friday\nBring a coat";

    expect(renderEmailBodyHtml(legacy).match(/<p /g)).toHaveLength(1);
    const resaved = exportMarkdown(legacy);

    expect(resaved).toBe("Hello {{first_name}}\n\nArrival is Friday\n\nBring a coat");
    expect(renderEmailBodyHtml(resaved).match(/<p /g)).toHaveLength(3);
  });

  it("keeps headings, lists and rules spaced when re-saving a legacy body", () => {
    const legacy = ["# Title", "Intro line", "- one", "- two", "After list", "---", "1. a", "2. b"].join("\n");
    const markdown = exportMarkdown(legacy);

    expect(markdown).toBe(
      ["# Title", "", "Intro line", "", "- one", "- two", "", "After list", "", "---", "", "1. a", "2. b"].join("\n"),
    );
    expect(exportMarkdown(markdown)).toBe(markdown);
    const html = renderEmailBodyHtml(markdown);
    expect(html).toContain("<h1 ");
    expect(html).toContain("<hr ");
    expect(html.match(/<ul /g)).toHaveLength(1);
    expect(html.match(/<li /g)).toHaveLength(4);
  });

  it("keeps a line break inside a paragraph as a br", () => {
    const markdown = exportMarkdown("Line one  \nLine two\n\nNext paragraph");

    expect(markdown).toBe("Line one  \nLine two\n\nNext paragraph");
    expect(exportMarkdown(markdown)).toBe(markdown);
    const html = renderEmailBodyHtml(markdown);
    expect(html.match(/<p /g)).toHaveLength(2);
    expect(html.match(/<br \/>/g)).toHaveLength(1);
  });
});

describe("check-in link warning", () => {
  it("warns when the check-in page link is outside a Markdown link", () => {
    expect(hasStandaloneCheckinQrUrl("Show this:\n\n{{checkin_qr_url}}")).toBe(true);
    expect(hasStandaloneCheckinQrUrl("See [pass]({{checkin_qr_url}}) or {{checkin_qr_url}}")).toBe(true);
  });

  it("stays quiet when it is inside a link, or absent", () => {
    expect(hasStandaloneCheckinQrUrl("[Open my pass]({{checkin_qr_url}})")).toBe(false);
    expect(hasStandaloneCheckinQrUrl("![QR]({{checkin_qr_image}})")).toBe(false);
    expect(hasStandaloneCheckinQrUrl("No tokens here")).toBe(false);
  });
});


describe("message body editor buttons and images (#824)", () => {
  it("round-trips a button link as [text](url){.button} on its own paragraph", () => {
    const source = "Hello.\n\n[Open my check-in pass]({{checkin_qr_url}}){.button}\n\nSee you soon.";
    expect(exportMarkdown(source)).toBe(source);
  });

  it("round-trips a button with a web address, beside an ordinary link", () => {
    const source = "[Register](https://events.example.test/register){.button}\n\nOr use [this link](https://example.test).";
    expect(exportMarkdown(source)).toBe(source);
  });

  it("round-trips an uploaded image as ![alt](msgfile:id)", () => {
    const source = "Welcome.\n\n![Map of the grounds](msgfile:cm9abc123def456)\n\nBring a coat.";
    expect(exportMarkdown(source)).toBe(source);
  });

  it("keeps a QR image token and an uploaded image apart", () => {
    const source = "![Check-in QR code]({{checkin_qr_image}})\n\n![Logo](msgfile:cm9abc123def456)";
    expect(exportMarkdown(source)).toBe(source);
  });

  it("renders what the editor exports as a button and an embedded-image reference", () => {
    const html = renderEmailBodyHtml(exportMarkdown("[Open](https://example.test/a){.button}\n\n![Map](msgfile:cm9abc123def456)"));
    expect(html).toContain('<a href="https://example.test/a"');
    expect(html).toContain('bgcolor="#0f6f8c"');
    expect(html).toContain('<img src="msgfile:cm9abc123def456" alt="Map"');
  });

  it("accepts only link targets the renderer accepts", () => {
    for (const ok of ["https://example.test/x", "http://example.test", "mailto:team@example.test", "tel:+15555550100", "{{portal_url}}"]) {
      expect(isAllowedEmailLinkTarget(ok), ok).toBe(true);
    }
    for (const bad of ["", "javascript:alert(1)", "data:text/html,x", "example.test", "https://a b", "ftp://example.test", "{{portal url}}", "https://x.test/a(b)"]) {
      expect(isAllowedEmailLinkTarget(bad), bad).toBe(false);
    }
  });
});

describe("hand-typed tokens (#859)", () => {
  function exportTyped(text: string) {
    const editor = loadMarkdown("");
    editor.update(() => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(text));
      $getRoot().clear().append(paragraph);
    }, { discrete: true });
    return editor.getEditorState().read(() => $exportEmailMarkdown());
  }

  it.each(["seminar_preferences", "checkin_qr_image", "announcement_body"])(
    "exports a typed {{%s}} without escaped underscores",
    (token) => {
      expect(exportTyped(`{{${token}}}`)).toBe(`{{${token}}}`);
    },
  );

  it("still escapes underscores outside tokens", () => {
    const out = exportTyped("snake_case {{announcement_body}} other_word");
    expect(out).toContain("snake\\_case");
    expect(out).toContain("{{announcement_body}}");
    expect(out).toContain("other\\_word");
  });
});
