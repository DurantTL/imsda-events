import "server-only";

import sanitizeHtml from "sanitize-html";

/**
 * The only place custom HTML (#816) is made safe.
 *
 * Custom HTML is a SYSTEM_ADMIN-only block, and even their markup is not
 * trusted: it is sanitized when it is saved and again every time it renders,
 * so a row written by any other path (an import, a restore, a future bug)
 * still cannot put script on the public page.
 *
 * Library: `sanitize-html`. It parses with htmlparser2 and rebuilds the
 * document from an allowlist, so it needs no DOM (no jsdom in the server
 * bundle, unlike DOMPurify via isomorphic-dompurify), works the same in the
 * route handler, the server component and a test, and is actively maintained.
 *
 * The allowlist is deliberately narrow:
 *  - no script, style, iframe, frame, object, embed, form, input, button,
 *    textarea, select, svg, math, link, meta or base;
 *  - no `style` or `class` attribute and no `on*` handler (nothing outside the
 *    attribute allowlist survives);
 *  - links are http, https, mailto or tel only;
 *  - images are an uploaded event file or an inline raster image
 *    (`data:image/png|jpeg|gif|webp`), never another site and never SVG.
 */

/** HTML that has been through `sanitizeCustomHtml`; nothing else may carry this type. */
export type SanitizedHtml = string & { readonly __sanitized: unique symbol };

const allowedTags = [
  "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr", "div", "span",
  "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "mark",
  "blockquote", "pre", "code",
  "ul", "ol", "li", "dl", "dt", "dd",
  "a", "img", "figure", "figcaption",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
];

/** Elements whose text content is dropped with the element, not left behind as visible text. */
const droppedWithContent = [
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
  "noscript", "template", "textarea", "select", "option", "svg", "math", "title",
  "head", "xmp", "plaintext", "noembed", "noframes",
];

const uploadedImagePath = /^\/api\/public\/events\/[A-Za-z0-9_-]{1,100}\/assets\/[A-Za-z0-9_-]{1,100}$/;
const inlineRasterImage = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

/** Whether an `<img src>` may stay: one of our own uploaded files, or an inline raster image. */
export function isAllowedHtmlImageSource(src: string) {
  return uploadedImagePath.test(src) || (src.length <= 20_000 && inlineRasterImage.test(src));
}

/** Uploaded files that already-sanitized HTML shows, so the asset route serves them and a delete is blocked. */
export function customHtmlAssetIds(sanitized: string): string[] {
  const ids = new Set<string>();
  for (const match of sanitized.matchAll(/src="\/api\/public\/events\/[A-Za-z0-9_-]{1,100}\/assets\/([A-Za-z0-9_-]{1,100})"/g)) {
    ids.add(match[1]);
  }
  return [...ids];
}

function positiveDimension(value: string | undefined) {
  return value && /^\d{1,4}$/.test(value) ? value : undefined;
}

const options: sanitizeHtml.IOptions = {
  allowedTags,
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
    ol: ["start"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["data"] },
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  nonTextTags: droppedWithContent,
  transformTags: {
    // A page already has one h1 (the event name or the banner).
    h1: "h2",
    a: (tagName, attribs) => {
      const href = attribs.href ?? "";
      const external = /^https?:\/\//i.test(href);
      const next: Record<string, string> = {};
      if (attribs.href !== undefined) next.href = attribs.href;
      if (attribs.title) next.title = attribs.title;
      if (external) {
        next.target = "_blank";
        next.rel = "noopener noreferrer";
      }
      return { tagName, attribs: next };
    },
    img: (tagName, attribs) => {
      const next: Record<string, string> = { loading: "lazy" };
      if (attribs.src !== undefined) next.src = attribs.src;
      next.alt = attribs.alt ?? "";
      if (attribs.title) next.title = attribs.title;
      const width = positiveDimension(attribs.width);
      const height = positiveDimension(attribs.height);
      if (width) next.width = width;
      if (height) next.height = height;
      return { tagName, attribs: next };
    },
  },
  exclusiveFilter: (frame) => {
    if (frame.tag !== "img") return false;
    const src = frame.attribs.src;
    return !src || !isAllowedHtmlImageSource(src);
  },
};

/** Strips everything outside the allowlist. Safe to call on its own output. */
export function sanitizeCustomHtml(html: string): SanitizedHtml {
  return sanitizeHtml(html, options) as SanitizedHtml;
}
