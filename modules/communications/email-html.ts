/**
 * Message bodies are authored, stored, and snapshotted as one plain-text
 * Markdown source. The HTML body is derived from that same snapshot at preview
 * and at delivery, so an email and its plain-text fallback can never drift, and
 * a captured row keeps meaning exactly what it said when it was captured.
 *
 * The renderer escapes the entire source before it looks for any markup, so
 * registrant-submitted values that reach a body through a token — names, form
 * answers, announcement text — can never introduce a tag, an attribute, or a
 * script. Only the small Markdown subset below produces elements, and only
 * `http`, `https`, `mailto`, and `tel` links survive.
 */

const ESCAPE_PATTERN = /[&<>"']/g;
const ESCAPE_REPLACEMENTS: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Schemes a rendered link may target. Anything else renders as inert text. */
const LINK_SCHEMES = ["http://", "https://", "mailto:", "tel:"];
/** Images are remote fetches by the mail client, so they stay web-only. */
const IMAGE_SCHEMES = ["http://", "https://"];

export function escapeHtml(value: string) {
  return value.replace(ESCAPE_PATTERN, (character) => ESCAPE_REPLACEMENTS[character]);
}

/**
 * The source is already escaped when this runs, so a scheme check on the
 * escaped text is the same check on the original: escaping only ever expands
 * characters into `&…;` entities and never introduces a `:` or a `/`.
 */
function safeUrl(rawUrl: string, schemes: readonly string[]) {
  const url = rawUrl.trim();
  if (!url || /[\s<>"']/.test(url)) return null;
  const lower = url.toLowerCase();
  return schemes.some((scheme) => lower.startsWith(scheme)) ? url : null;
}

const IMAGE_PATTERN = /!\[([^\]]*)\]\(([^()\s]+)\)/g;
const LINK_PATTERN = /\[([^\]]+)\]\(([^()\s]+)\)/g;
const BOLD_PATTERN = /\*\*([^*]+)\*\*/g;
const ITALIC_PATTERN = /(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g;
const CODE_PATTERN = /`([^`\n]+)`/g;
const BARE_URL_PATTERN = /(^|[\s(])(https?:\/\/[^\s<>"')]+)/g;

const LINK_STYLE = "color:#0f6f8c;text-decoration:underline;";

/**
 * Inline markup for one already-escaped line. Images run before links so that
 * `![alt](url)` is never mistaken for a link whose text starts with `!`.
 */
function renderInline(escaped: string) {
  return escaped
    .replace(IMAGE_PATTERN, (match, alt: string, rawUrl: string) => {
      const url = safeUrl(rawUrl, IMAGE_SCHEMES);
      if (!url) return alt;
      return `<img src="${url}" alt="${alt}" style="max-width:100%;height:auto;border:0;display:block;" />`;
    })
    .replace(LINK_PATTERN, (match, text: string, rawUrl: string) => {
      const url = safeUrl(rawUrl, LINK_SCHEMES);
      if (!url) return text;
      return `<a href="${url}" style="${LINK_STYLE}">${text}</a>`;
    })
    .replace(BARE_URL_PATTERN, (match, lead: string, rawUrl: string) => {
      const url = safeUrl(rawUrl, IMAGE_SCHEMES);
      if (!url) return match;
      return `${lead}<a href="${url}" style="${LINK_STYLE}">${url}</a>`;
    })
    .replace(CODE_PATTERN, (match, code: string) => (
      `<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f1f5f7;padding:1px 4px;border-radius:3px;">${code}</code>`
    ))
    .replace(BOLD_PATTERN, (match, text: string) => `<strong>${text}</strong>`)
    .replace(ITALIC_PATTERN, (match, lead: string, text: string) => `${lead}<em>${text}</em>`);
}

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "rule" };

const HEADING_PATTERN = /^(#{1,3})\s+(.*)$/;
const UNORDERED_PATTERN = /^[-*]\s+(.*)$/;
const ORDERED_PATTERN = /^\d+[.)]\s+(.*)$/;
const RULE_PATTERN = /^(-{3,}|_{3,}|\*{3,})$/;

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraph });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
      list = null;
    }
  };

  for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const trimmed = line.trim();
    const rule = RULE_PATTERN.exec(trimmed);
    if (rule) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING_PATTERN.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim(),
      });
      continue;
    }

    const unordered = UNORDERED_PATTERN.exec(trimmed);
    const ordered = unordered ? null : ORDERED_PATTERN.exec(trimmed);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      if (list && list.ordered !== isOrdered) flushList();
      if (!list) list = { ordered: isOrdered, items: [] };
      list.items.push((unordered?.[1] ?? ordered?.[1] ?? "").trim());
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  return blocks;
}

const HEADING_STYLES: Readonly<Record<1 | 2 | 3, string>> = {
  1: "margin:0 0 12px;font-size:22px;line-height:1.3;color:#0b2b3a;font-weight:700;",
  2: "margin:24px 0 8px;font-size:18px;line-height:1.35;color:#0b2b3a;font-weight:700;",
  3: "margin:20px 0 6px;font-size:15px;line-height:1.4;color:#0b2b3a;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;",
};
const PARAGRAPH_STYLE = "margin:0 0 14px;font-size:15px;line-height:1.6;color:#22333b;";
const LIST_STYLE = "margin:0 0 14px;padding-left:22px;font-size:15px;line-height:1.6;color:#22333b;";
const RULE_STYLE = "border:0;border-top:1px solid #d9e2e6;margin:22px 0;";

/**
 * Render a Markdown body into the HTML fragment that goes inside the email
 * layout. Safe to call on any string, including one that already contains
 * angle brackets or quotes.
 */
export function renderEmailBodyHtml(body: string) {
  const blocks = parseBlocks(escapeHtml(body));
  return blocks
    .map((block) => {
      if (block.kind === "rule") return `<hr style="${RULE_STYLE}" />`;
      if (block.kind === "heading") {
        return `<h${block.level} style="${HEADING_STYLES[block.level]}">${renderInline(block.text)}</h${block.level}>`;
      }
      if (block.kind === "list") {
        const tag = block.ordered ? "ol" : "ul";
        const items = block.items
          .map((item) => `<li style="margin:0 0 4px;">${renderInline(item)}</li>`)
          .join("");
        return `<${tag} style="${LIST_STYLE}">${items}</${tag}>`;
      }
      return `<p style="${PARAGRAPH_STYLE}">${block.lines.map(renderInline).join("<br />")}</p>`;
    })
    .join("\n");
}

export type EmailHtmlDocumentInput = {
  /** Shown in the client's tab and read by screen readers. */
  title: string;
  /** The Markdown body. Escaped and rendered by `renderEmailBodyHtml`. */
  body: string;
  /** Small line under the body, used for the sender identity. */
  footer?: string | null;
};

/**
 * Wrap a rendered body in the email layout. Table-based and inline-styled
 * because mail clients strip stylesheets, with a light-scheme lock so a dark
 * client does not invert the header out of legibility.
 */
export function renderEmailHtmlDocument(input: EmailHtmlDocumentInput) {
  const title = escapeHtml(input.title.trim());
  const footer = input.footer?.trim()
    ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#6b7c85;">${renderInline(escapeHtml(input.footer.trim()))}</p>`
    : "";
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="color-scheme" content="light" />',
    '<meta name="supported-color-schemes" content="light" />',
    `<title>${title}</title>`,
    "</head>",
    '<body style="margin:0;padding:0;background:#eef2f4;-webkit-font-smoothing:antialiased;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2f4;padding:24px 12px;">',
    "<tr><td align=\"center\">",
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #d9e2e6;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">',
    '<tr><td style="background:#0b2b3a;padding:18px 28px;">',
    '<span style="color:#ffffff;font-size:14px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">IMSDA Events</span>',
    "</td></tr>",
    '<tr><td style="padding:28px;">',
    renderEmailBodyHtml(input.body),
    footer,
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("\n");
}
