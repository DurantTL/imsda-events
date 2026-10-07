import "server-only";

import { readAsset } from "@/modules/events/asset-storage";

/**
 * A `Content-Disposition` value for any display name. A header value is Latin-1 at best, so a name like
 * "Women’s Retreat – Agenda.pdf" (a typographic apostrophe and an en dash) would throw when the header is set. The
 * plain `filename` is an ASCII fallback with quotes, backslashes, control characters and anything outside ASCII
 * removed, so it can never break out of the header; `filename*` carries the real name, percent-encoded as UTF-8
 * (RFC 5987/6266), which every current browser prefers.
 */
export function contentDisposition(disposition: "attachment" | "inline", displayName: string) {
  const fallback = displayName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/["\\%;]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "download";
  const encoded = encodeURIComponent(displayName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Serves a stored file with every header that stops it becoming something else.
 *
 * `nosniff` keeps a browser from re-deciding the type. `attachment` means even
 * a PDF — a format that can carry script — is downloaded rather than rendered
 * in this origin. The CSP is the belt to that brace: nothing in the response is
 * permitted to load or execute anything.
 */
/**
 * `inline` is only ever honored for a verified image content type — this is
 * what lets an artwork picker render a thumbnail without opening the same
 * door for a PDF (a format that can carry script) to render in this origin.
 */
export async function eventAssetResponse(
  asset: { displayName: string; contentType: string; storageKey: string },
  disposition: "attachment" | "inline" = "attachment",
) {
  const bytes = await readAsset(asset.storageKey);

  const effectiveDisposition = disposition === "inline" && asset.contentType.startsWith("image/") ? "inline" : "attachment";
  return new Response(new Uint8Array(bytes), {
    headers: {
      // The verified type from upload, never anything a request supplied.
      "Content-Type": asset.contentType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": contentDisposition(effectiveDisposition, asset.displayName),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
    },
  });
}
