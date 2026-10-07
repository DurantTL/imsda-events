import "server-only";

import { createHash } from "node:crypto";
import { rewriteEmailImages, emailImageSources } from "@/modules/communications/email-html";
import {
  attachmentSetIssue,
  MAX_INLINE_IMAGES_PER_MESSAGE,
  MAX_INLINE_IMAGES_TOTAL_BYTES,
  MESSAGE_FILE_ID_PATTERN,
  MESSAGE_FILE_SCHEME,
  MessageFileDeliveryError,
} from "@/modules/communications/message-file-rules";

/**
 * Turns an outbox row's file references and its body into the parts the email adapter sends (#824).
 *
 * - Every ATTACHMENT file becomes a real attachment.
 * - Every image the HTML shows becomes an inline part with a content id, and its `<img src>` is rewritten to
 *   `cid:<id>`, so the client shows it without "download pictures":
 *   - an uploaded image (`msgfile:<id>`) is read from private storage;
 *   - a check-in QR image is rendered here, in-process, from the pass id, not fetched over HTTP.
 * - An uploaded picture that cannot be read fails the message, like an attachment: it has no public address, and a
 *   message must never go out missing something staff put in it. Only a check-in QR falls back, to the remote URL
 *   it had before; the count of those is returned so the caller can log it.
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
  const decided = new Map<string, { src: string } | null>();
  const budget = { uploadBytes: 0, uploads: 0, qrBytes: 0, qrs: 0 };
  let unembedded = 0;
  for (const src of sources) {
    if (decided.has(src)) continue;
    if (src.startsWith(MESSAGE_FILE_SCHEME)) {
      // An uploaded picture has no public address to fall back to, so a picture that cannot be sent fails the
      // message (as an attachment does) rather than going out without it. The count and size were checked when
      // staff saved, so this is a defence, not a path.
      const id = src.slice(MESSAGE_FILE_SCHEME.length);
      const file = MESSAGE_FILE_ID_PATTERN.test(id) ? inlineFiles.get(id) : undefined;
      if (!file) throw new MessageFileDeliveryError("ATTACHMENT_MISSING", false);
      const bytes = await dependencies.readFile(file);
      budget.uploads += 1;
      budget.uploadBytes += bytes.byteLength;
      if (budget.uploads > MAX_INLINE_IMAGES_PER_MESSAGE || budget.uploadBytes > MAX_INLINE_IMAGES_TOTAL_BYTES) {
        throw new Error("The pictures in this message are over the allowed size, so it was not sent.");
      }
      const contentId = contentIdFor(src);
      attachments.push({ filename: file.filename, contentType: file.contentType, content: bytes, contentId });
      decided.set(src, { src: `cid:${contentId}` });
      continue;
    }
    const qr = qrPattern ? qrPattern.exec(src) : null;
    if (!qr) {
      // A remote image the author chose. Left exactly as written.
      decided.set(src, null);
      continue;
    }
    // A check-in QR is the one picture with a fallback: its remote address still works. Embedding is best effort.
    let bytes: Uint8Array | null = null;
    try {
      bytes = await dependencies.renderQrPng(decodeURIComponent(qr[1]), decodeURIComponent(qr[2]));
    } catch {
      bytes = null;
    }
    if (
      !bytes
      || budget.qrs >= MAX_INLINE_IMAGES_PER_MESSAGE
      || budget.qrBytes + bytes.byteLength > MAX_INLINE_IMAGES_TOTAL_BYTES
    ) {
      unembedded += 1;
      decided.set(src, null);
      continue;
    }
    const contentId = contentIdFor(src);
    budget.qrs += 1;
    budget.qrBytes += bytes.byteLength;
    attachments.push({ filename: "check-in-qr.png", contentType: "image/png", content: bytes, contentId });
    decided.set(src, { src: `cid:${contentId}` });
  }

  const bodyHtml = rewriteEmailImages(input.bodyHtml, (src) => decided.get(src) ?? null);
  return { bodyHtml, attachments, unembeddedImageCount: unembedded };
}
