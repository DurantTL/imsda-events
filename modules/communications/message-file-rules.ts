/**
 * The rules for files that travel with an email (#824), kept free of server-only imports so the editor, the upload
 * route and the delivery worker all apply the same ones.
 *
 * A file's type is decided by its bytes. The type a browser sends with an upload is a claim, so it is never
 * consulted: a file whose bytes match none of the types below is refused, whatever it was called.
 */

const MB = 1024 * 1024;

/** One attachment. */
export const MAX_MESSAGE_FILE_BYTES = 10 * MB;
/** Every attachment on one message, together. */
export const MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES = 20 * MB;
/** A downloadable attachment count, so a message stays a message. */
export const MAX_MESSAGE_ATTACHMENT_COUNT = 10;
/** An image placed in a message body is a small picture, not a photo library. */
export const MAX_INLINE_IMAGE_BYTES = 2 * MB;
/** Embedded images on one message, together, and how many. Past either, an image is sent as its remote link. */
export const MAX_INLINE_IMAGES_TOTAL_BYTES = 6 * MB;
export const MAX_INLINE_IMAGES_PER_MESSAGE = 30;

export const MESSAGE_FILE_TYPES = {
  "application/pdf": { extension: "pdf", label: "PDF" },
  "image/png": { extension: "png", label: "PNG image" },
  "image/jpeg": { extension: "jpg", label: "JPEG image" },
  "image/webp": { extension: "webp", label: "WebP image" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { extension: "docx", label: "Word document" },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { extension: "xlsx", label: "Excel workbook" },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { extension: "pptx", label: "PowerPoint presentation" },
} as const;

export type MessageFileType = keyof typeof MESSAGE_FILE_TYPES;

export const MESSAGE_FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.pptx";
export const MESSAGE_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

export function isMessageImageType(type: string) {
  return type === "image/png" || type === "image/jpeg" || type === "image/webp";
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value);
}

/**
 * The type of a file, from its bytes alone, or null when it is none of the allowed types.
 *
 * Word, Excel and PowerPoint files are ZIP packages, so the ZIP signature is not enough: a plain .zip must not pass
 * as a document. The package has to hold the part each format requires, and a package carrying a macro project is
 * refused outright.
 */
export function sniffMessageFileType(bytes: Uint8Array): MessageFileType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // Entry names are stored uncompressed in the local headers and the central directory.
    const names = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
    if (!names.includes("[Content_Types].xml") || names.includes("vbaProject.bin")) return null;
    if (names.includes("word/document.xml")) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if (names.includes("xl/workbook.xml")) {
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }
    if (names.includes("ppt/presentation.xml")) {
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    }
  }
  return null;
}

/**
 * A display name, stripped of everything that gives a file name power. It is shown, put in a `Content-Disposition`
 * header, and used as the attachment name in the email, never as a path. The extension is made to match the sniffed
 * type, so a PDF uploaded as "notes.exe" is offered as "notes.pdf".
 */
export function safeMessageFileName(rawName: string, type: MessageFileType) {
  const extension = MESSAGE_FILE_TYPES[type].extension;
  const base = rawName
    .replace(/[\\/]/g, " ")
    .replace(/["\\\x00-\x1f\x7f<>:*?|]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\s]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim().slice(0, 100);
  return `${stem || "attachment"}.${extension}`;
}

export type MessageFileRecord = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  isInlineImage: boolean;
  createdAt: string;
  /** The staff-only route that serves the file. */
  url: string;
};

export function messageFileUrl(eventId: string, fileId: string, disposition: "inline" | "attachment" = "attachment") {
  return `/api/events/${encodeURIComponent(eventId)}/message-files/${encodeURIComponent(fileId)}${disposition === "inline" ? "?disposition=inline" : ""}`;
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

/** The scheme an uploaded image uses in a body: `![alt](msgfile:<id>)`. Delivery swaps it for a `cid:` part. */
export const MESSAGE_FILE_SCHEME = "msgfile:";
export const MESSAGE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Every uploaded image a rendered HTML body embeds, in order, without repeats. */
export function messageFileIdsInHtml(html: string) {
  const ids: string[] = [];
  for (const match of html.matchAll(/<img src="msgfile:([A-Za-z0-9_-]{8,64})"/g)) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

/** Every uploaded image a Markdown body refers to, in order, without repeats. */
export function messageFileIdsInMarkdown(markdown: string) {
  const ids: string[] = [];
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(msgfile:([A-Za-z0-9_-]{8,64})\)/g)) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

/**
 * The plain-text form of a body source. An embedded image has no text equivalent but its description, and a button
 * link is an ordinary link; neither marker syntax should reach someone reading the fallback part.
 */
export function plainTextFromMessageSource(text: string) {
  return text
    .replace(/!\[([^\]]*)\]\(msgfile:[A-Za-z0-9_-]{8,64}\)/g, (match, alt: string) => (alt.trim() ? `[Image: ${alt.trim()}]` : ""))
    .replace(/(\[[^\]]+\]\([^()\s]+\))\{\.button\}/g, "$1");
}

export type AttachmentTotalsIssue = { code: "TOO_MANY" | "TOTAL_TOO_LARGE"; message: string };

/** Whether a set of attachments fits the per-message limits. Inline images are checked separately. */
export function attachmentSetIssue(files: ReadonlyArray<{ sizeBytes: number }>): AttachmentTotalsIssue | null {
  if (files.length > MAX_MESSAGE_ATTACHMENT_COUNT) {
    return { code: "TOO_MANY", message: `Attach at most ${MAX_MESSAGE_ATTACHMENT_COUNT} files to one message.` };
  }
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (total > MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES) {
    return {
      code: "TOTAL_TOO_LARGE",
      message: `Attachments may total ${formatFileSize(MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES)} or less; these total ${formatFileSize(total)}.`,
    };
  }
  return null;
}
