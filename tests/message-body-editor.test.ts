import { $getRoot, createEditor } from "lexical";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
} from "@lexical/markdown";
import { HeadingNode } from "@lexical/rich-text";
import { HorizontalRuleNode } from "@lexical/extension";
import { describe, expect, it } from "vitest";
import {
  EMAIL_MARKDOWN_TRANSFORMERS,
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
    ],
    onError(error) {
      throw error;
    },
  });

  editor.update(() => {
    $convertFromMarkdownString(source, EMAIL_MARKDOWN_TRANSFORMERS, undefined, true);
  }, { discrete: true });

  return editor;
}

function exportMarkdown(source: string) {
  return loadMarkdown(source).getEditorState().read(() => (
    $convertToMarkdownString(EMAIL_MARKDOWN_TRANSFORMERS, undefined, true)
  ));
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
});
