import "server-only";

import { createHash } from "node:crypto";
import { rewriteEmailImages, emailImageSources } from "@/modules/communications/email-html";
import {
  attachmentSetIssue,
  MAX_INLINE_IMAGES_PER_MESSAGE,
  MAX_INLINE_IMAGES_TOTAL_BYTES,
  MESSAGE_FILE_ID_PATTERN,
  MESSAGE_FILE_SCHEME,
} from "@/modules/communications/message-file-rules";

/**
 * Turns an outbox row's file references and its body into the parts the email adapter sends (#824).
 *
 * - Every ATTACHMENT file becomes a real attachment.
 * - Every image the HTML shows becomes an inline part with a content id, and its `<img src>` is rewritten to
 *   `cid:<id>`, so the client shows it without "download pictures":
 *   - an uploaded image (`msgfile:<id>`) is read from private storage;
 *   - a check-in QR image is rendered here, in-process, from the pass id, not fetched over HTTP.
 * - When an image cannot be embedded the message still goes out. A QR keeps its remote URL as before; an uploaded
 *   image, which has no public URL, is replaced by its description.
 */

export type DeliveryFileLink = {
  disposition: "ATTACHMENT" | "INLINE";
  file: {
    id: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
  };
};

export type EmailPart = {
  filename: string;
  contentType: string;
  content: Uint8Array;
  contentId?: string;
};

export type EmailPartDependencies = {
  /** Reads a stored file and checks it against its recorded hash. */
  readFile: (file: DeliveryFileLink["file"]) => Promise<Uint8Array>;
  /** Renders an attendee pass as a PNG from the registration access token and the attendee id; null when unavailable. */
  renderQrPng: (registrationAccessToken: string, attendeeId: string) => Promise<Uint8Array | null>;
  /** The app's own origin, which a pass image URL must carry to be rendered here; null disables QR embedding. */
  appOrigin: () => string | null;
};

export type EmailPartsResult = {
  bodyHtml: string | null;
  attachments: EmailPart[];
  /** Images left as remote links or dropped because embedding failed or exceeded a cap. */
  unembeddedImageCount: number;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contentIdFor(source: string) {
  return `${createHash("sha256").update(source).digest("hex").slice(0, 24)}@imsda-events`;
}

export async function buildEmailParts(
  input: { bodyHtml: string | null; files: readonly DeliveryFileLink[] },
  dependencies: EmailPartDependencies,
): Promise<EmailPartsResult> {
  const attachments: EmailPart[] = [];

  const attached = input.files.filter((link) => link.disposition === "ATTACHMENT");
  const issue = attachmentSetIssue(attached.map((link) => link.file));
  if (issue) throw new Error(`The attachments cannot be sent: ${issue.message}`);
  for (const link of attached) {
    attachments.push({
      filename: link.file.filename,
      contentType: link.file.contentType,
      content: await dependencies.readFile(link.file),
    });
  }

  if (!input.bodyHtml) return { bodyHtml: null, attachments, unembeddedImageCount: 0 };

  const sources = emailImageSources(input.bodyHtml);
  if (sources.length === 0) return { bodyHtml: input.bodyHtml, attachments, unembeddedImageCount: 0 };

  const inlineFiles = new Map(
    input.files.filter((link) => link.disposition === "INLINE").map((link) => [link.file.id, link.file]),
  );
  const origin = dependencies.appOrigin();
  const qrPattern = origin
    ? new RegExp(`^${escapeRegExp(origin)}/api/public/manage/([^/?#]+)/attendee-passes/([^/?#]+)/qr\\?format=png$`)
    : null;

  // Decide each distinct source once: the same image shown twice is one part.
  const decided = new Map<string, { src: string } | { drop: true } | null>();
  let inlineBytes = 0;
  let embeddedCount = 0;
  let unembedded = 0;
  for (const src of sources) {
    if (decided.has(src)) continue;
    const isUpload = src.startsWith(MESSAGE_FILE_SCHEME);
    const qr = !isUpload && qrPattern ? qrPattern.exec(src) : null;
    if (!isUpload && !qr) {
      // A remote image the author chose. Left exactly as written.
      decided.set(src, null);
      continue;
    }
    // The remote URL is the fallback for a QR; an upload has none, so its fallback is its description.
    const fallback = isUpload ? { drop: true as const } : null;
    let bytes: Uint8Array | null = null;
    let part: Omit<EmailPart, "content" | "contentId"> | null = null;
    try {
      if (isUpload) {
        const id = src.slice(MESSAGE_FILE_SCHEME.length);
        const file = MESSAGE_FILE_ID_PATTERN.test(id) ? inlineFiles.get(id) : undefined;
        if (file) {
          bytes = await dependencies.readFile(file);
          part = { filename: file.filename, contentType: file.contentType };
        }
      } else if (qr) {
        bytes = await dependencies.renderQrPng(decodeURIComponent(qr[1]), decodeURIComponent(qr[2]));
        part = { filename: "check-in-qr.png", contentType: "image/png" };
      }
    } catch {
      bytes = null;
    }
    if (
      !bytes
      || !part
      || embeddedCount >= MAX_INLINE_IMAGES_PER_MESSAGE
      || inlineBytes + bytes.byteLength > MAX_INLINE_IMAGES_TOTAL_BYTES
    ) {
      unembedded += 1;
      decided.set(src, fallback);
      continue;
    }
    const contentId = contentIdFor(src);
    inlineBytes += bytes.byteLength;
    embeddedCount += 1;
    attachments.push({ ...part, content: bytes, contentId });
    decided.set(src, { src: `cid:${contentId}` });
  }

  const bodyHtml = rewriteEmailImages(input.bodyHtml, (src) => decided.get(src) ?? null);
  return { bodyHtml, attachments, unembeddedImageCount: unembedded };
}
