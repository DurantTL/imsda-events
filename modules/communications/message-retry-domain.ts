import { createHash } from "node:crypto";

export type MessageRetryFingerprintInput = {
  eventId: string;
  sourceMessageId: string;
  deliveryMode: "DISABLED" | "LOCAL_CAPTURE" | "EXTERNAL_EMAIL";
  registrationId: string | null;
  templateVersionId: string | null;
  templateKey: string;
  recipientKind: string;
  recipientEmail: string;
  recipientName: string | null;
  senderNameSnapshot: string;
  senderEmailSnapshot: string | null;
  replyToEmailSnapshot: string | null;
  subjectSnapshot: string;
  bodyTextSnapshot: string;
};

export function messageRetryRequestFingerprint(
  input: MessageRetryFingerprintInput,
) {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    action: "STAFF_MESSAGE_RETRY",
    eventId: input.eventId,
    sourceMessageId: input.sourceMessageId,
    deliveryMode: input.deliveryMode,
    registrationId: input.registrationId,
    templateVersionId: input.templateVersionId,
    templateKey: input.templateKey,
    recipientKind: input.recipientKind,
    recipientEmail: input.recipientEmail,
    recipientName: input.recipientName,
    senderNameSnapshot: input.senderNameSnapshot,
    senderEmailSnapshot: input.senderEmailSnapshot,
    replyToEmailSnapshot: input.replyToEmailSnapshot,
    subjectSnapshot: input.subjectSnapshot,
    bodyTextSnapshot: input.bodyTextSnapshot,
  })).digest("hex");
}

export function messageRetryIdempotencyKey(
  eventId: string,
  clientRequestId: string,
) {
  return `message-retry:${eventId}:${clientRequestId}`;
}
