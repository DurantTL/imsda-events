import "server-only";

import { readAsset } from "@/modules/events/asset-storage";

/**
 * Serves a stored file with every header that stops it becoming something else.
 *
 * `nosniff` keeps a browser from re-deciding the type. `attachment` means even
 * a PDF — a format that can carry script — is downloaded rather than rendered
 * in this origin. The CSP is the belt to that brace: nothing in the response is
 * permitted to load or execute anything.
 */
export async function eventAssetResponse(asset: {
  displayName: string;
  contentType: string;
  storageKey: string;
}) {
  const bytes = await readAsset(asset.storageKey);
  // The name is quoted and stripped of quotes so it cannot break out of the
  // header and add directives of its own.
  const safeName = asset.displayName.replace(/["\\]/g, "");
  return new Response(new Uint8Array(bytes), {
    headers: {
      // The verified type from upload, never anything a request supplied.
      "Content-Type": asset.contentType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
    },
  });
}
