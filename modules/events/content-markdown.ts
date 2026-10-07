/**
 * A small, constrained Markdown reader for the FORMATTED_TEXT block (#816).
 *
 * The block is stored as Markdown source and turned into a tree of plain
 * values here; the renderer maps that tree to React elements. There is no
 * HTML output anywhere in this path, so authored text can only ever become the
 * elements this file names. Supported:
 *
 *  - `## Heading` and `### Heading` (a single `#` is treated as `##`, and
 *    deeper levels as `###`, because the page already has its own h1)
 *  - paragraphs, `**bold**`, `*italic*` or `_italic_`
 *  - `[text](https://link)` for http, https and mailto addresses only
 *  - `- item` / `* item` bullet lists and `1. item` numbered lists
 *
 * Anything else (raw HTML, images, tables, code) is kept as literal text.
 */

export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "em"; children: MarkdownInline[] }
  | { type: "link"; href: string; children: MarkdownInline[] };

export type MarkdownBlock =
  | { type: "heading"; level: 2 | 3; children: MarkdownInline[] }
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "ul"; items: MarkdownInline[][] }
  | { type: "ol"; start: number; items: MarkdownInline[][] };

/** The only link targets that survive: http(s) and a plain mailto address. */
export function safeMarkdownHref(value: string): string | null {
  const href = value.trim();
  if (!href || /[\s<>"'`]/.test(href) || href.length > 500) return null;
  if (/^mailto:[^\s@?#]+@[^\s@?#]+\.[^\s@?#]+$/i.test(href)) return href;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? href : null;
  } catch {
    return null;
  }
}

const inlinePattern = /\[([^\]\n]{1,300})\]\(([^)\s]{1,500})\)|\*\*([^\n]+?)\*\*|(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<![\w_])_([^_\n]+?)_(?![\w_])/;

/** Inline formatting. Unbalanced markers stay as literal characters. */
export function parseMarkdownInline(source: string, depth = 0): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let rest = source;
  while (rest.length > 0) {
    const match = inlinePattern.exec(rest);
    if (!match || depth > 4) {
      nodes.push({ type: "text", text: rest });
      break;
    }
    if (match.index > 0) nodes.push({ type: "text", text: rest.slice(0, match.index) });
    const [whole, linkText, linkTarget, strong, emStar, emUnderscore] = match;
    if (linkText !== undefined) {
      const href = safeMarkdownHref(linkTarget);
      // An unsafe target keeps the words and drops the link.
      nodes.push(href
        ? { type: "link", href, children: parseMarkdownInline(linkText, depth + 1) }
        : { type: "text", text: linkText });
    } else if (strong !== undefined) {
      nodes.push({ type: "strong", children: parseMarkdownInline(strong, depth + 1) });
    } else {
      nodes.push({ type: "em", children: parseMarkdownInline(emStar ?? emUnderscore ?? "", depth + 1) });
    }
    rest = rest.slice(match.index + whole.length);
  }
  return nodes;
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", children: parseMarkdownInline(paragraph.join(" ")) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index].trim();
    if (!line) {
      flushParagraph();
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: heading[1].length <= 2 ? 2 : 3,
        children: parseMarkdownInline(heading[2]),
      });
      index += 1;
      continue;
    }

    if (/^[-*]\s+\S/.test(line)) {
      flushParagraph();
      const items: MarkdownInline[][] = [];
      while (index < lines.length) {
        const match = /^[-*]\s+(\S.*)$/.exec(lines[index].trim());
        if (!match) break;
        items.push(parseMarkdownInline(match[1]));
        index += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (/^\d{1,4}[.)]\s+\S/.test(line)) {
      flushParagraph();
      const items: MarkdownInline[][] = [];
      const start = Number(/^(\d+)/.exec(line)![1]);
      while (index < lines.length) {
        const match = /^\d{1,4}[.)]\s+(\S.*)$/.exec(lines[index].trim());
        if (!match) break;
        items.push(parseMarkdownInline(match[1]));
        index += 1;
      }
      blocks.push({ type: "ol", start, items });
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return blocks;
}
