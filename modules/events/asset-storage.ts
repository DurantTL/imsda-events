import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where uploaded event files live on disk, and the rules for putting them there.
 *
 * Two things this module exists to prevent.
 *
 * A stored file is never named by whoever uploaded it. The name a browser sends
 * is attacker-controlled text — "../../.env" is a valid filename as far as a
 * form is concerned — so the path comes from a generated identifier and the
 * original name is kept only as a label to show and to offer on download.
 *
 * A stored file's type is never taken from the upload either. `Content-Type` in
 * a multipart part is a claim, not a fact, so the bytes are checked against the
 * signature the claimed type requires. A PDF that does not begin with %PDF- is
 * refused rather than served back to a visitor as one.
 */

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

/**
 * Deliberately short. Every entry is something a browser will not execute in
 * the page's origin, and each carries a signature that can be verified. SVG is
 * excluded on purpose: it is a document that can carry script, so serving one
 * from this origin would hand an uploader a cross-site scripting primitive.
 */
export const ALLOWED_ASSET_TYPES = {
  "application/pdf": { extension: "pdf", signatures: ["255044462d"] },
  "image/png": { extension: "png", signatures: ["89504e470d0a1a0a"] },
  "image/jpeg": { extension: "jpg", signatures: ["ffd8ff"] },
  "image/webp": { extension: "webp", signatures: ["52494646"] },
} as const;

export type AllowedAssetType = keyof typeof ALLOWED_ASSET_TYPES;

export function isAllowedAssetType(value: string): value is AllowedAssetType {
  return Object.hasOwn(ALLOWED_ASSET_TYPES, value);
}

/** Whether the bytes actually begin the way the claimed type requires. */
export function bytesMatchType(bytes: Uint8Array, type: AllowedAssetType) {
  const prefix = Buffer.from(bytes.subarray(0, 12)).toString("hex");
  return ALLOWED_ASSET_TYPES[type].signatures.some(
    (signature) => prefix.startsWith(signature),
  );
}

/**
 * A display name, stripped of everything that gives a filename power.
 *
 * Directory separators and leading dots go, because this is echoed in a
 * `Content-Disposition` header and written into a page.
 */
export function safeDisplayName(rawName: string, type: AllowedAssetType) {
  const base = rawName
    // Separators become spaces so the remaining words stay readable.
    .replace(/[\\/]/g, " ")
    // Quotes, backslashes, and control characters, listed rather than given as
    // a range: this value ends up inside a quoted Content-Disposition header,
    // where a stray quote or newline would let the name add directives of its
    // own. Ordinary punctuation and spaces are left alone so a real filename
    // still reads like one.
    .replace(/["\\\x00-\x1f\x7f]/g, "")
    // Runs of dots carry no meaning in a label and read as a traversal attempt
    // to anyone shown one.
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\s]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 120);
  return base || `upload.${ALLOWED_ASSET_TYPES[type].extension}`;
}

function storageRoot() {
  return process.env.ASSET_STORAGE_DIR?.trim()
    || path.join(process.cwd(), "storage", "event-assets");
}

/**
 * Resolves a storage key to an absolute path, refusing anything that escapes.
 *
 * Keys are generated here and never come from a request, so this should be
 * unreachable — which is exactly why it is checked. A traversal bug is only
 * ever one careless caller away, and the cost of the check is nothing.
 */
function resolveStoragePath(storageKey: string) {
  const root = storageRoot();
  const resolved = path.resolve(root, storageKey);
  const rootWithSep = path.resolve(root) + path.sep;
  if (!resolved.startsWith(rootWithSep)) {
    throw new Error("An event asset path resolved outside its storage directory.");
  }
  return resolved;
}

export type StoredAsset = {
  storageKey: string;
  byteSize: number;
  checksum: string;
};

export async function writeAsset(
  eventId: string,
  type: AllowedAssetType,
  bytes: Uint8Array,
): Promise<StoredAsset> {
  // The event id partitions the directory; the file name is generated. Neither
  // comes from the upload.
  const storageKey = path.join(
    eventId,
    `${randomUUID()}.${ALLOWED_ASSET_TYPES[type].extension}`,
  );
  const destination = resolveStoragePath(storageKey);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { mode: 0o640 });
  return {
    storageKey,
    byteSize: bytes.byteLength,
    checksum: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function readAsset(storageKey: string) {
  return readFile(resolveStoragePath(storageKey));
}

export async function deleteAsset(storageKey: string) {
  try {
    await unlink(resolveStoragePath(storageKey));
  } catch (error) {
    // A file already gone is the state we wanted. Anything else is worth
    // knowing about, but never worth failing the request the user made.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}
