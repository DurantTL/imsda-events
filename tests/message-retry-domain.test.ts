import { describe, expect, it } from "vitest";
import {
  messageRetryIdempotencyKey,
  messageRetryRequestFingerprint,
  type MessageRetryFingerprintInput,
} from "@/modules/communications/message-retry-domain";
import { messageRetryInputSchema } from "@/modules/communications/schemas";

function fingerprintInput(
  overrides: Partial<MessageRetryFingerprintInput> = {},
): MessageRetryFingerprintInput {
  return {
    eventId: "event-1",
    sourceMessageId: "message-1",
    deliveryMode: "EXTERNAL_EMAIL",
    registrationId: "registration-1",
    templateVersionId: "template-version-1",
    templateKey: "REGISTRATION_CONFIRMATION_UNPAID",
    recipientKind: "REGISTRANT",
    recipientEmail: "recipient@example.test",
    recipientName: "Sample Recipient",
    senderNameSnapshot: "IMSDA Events",
    senderEmailSnapshot: "registration@example.test",
    replyToEmailSnapshot: "help@example.test",
    subjectSnapshot: "Immutable subject",
    bodyTextSnapshot: "Immutable body with __IMSDA_PRIVATE_MANAGE_LINK__",
    ...overrides,
  };
}

describe("message-retry request identity", () => {
  it("fingerprints the immutable source and delivery mode deterministically", () => {
    const first = messageRetryRequestFingerprint(fingerprintInput());
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(messageRetryRequestFingerprint(fingerprintInput())).toBe(first);
    expect(messageRetryRequestFingerprint(fingerprintInput({
      sourceMessageId: "message-2",
    }))).not.toBe(first);
    expect(messageRetryRequestFingerprint(fingerprintInput({
      deliveryMode: "LOCAL_CAPTURE",
    }))).not.toBe(first);
    expect(messageRetryRequestFingerprint(fingerprintInput({
      bodyTextSnapshot: "Changed immutable body",
    }))).not.toBe(first);
  });

  it("scopes one client UUID to the event instead of the selected source", () => {
    expect(messageRetryIdempotencyKey(
      "event-1",
      "c9c5758f-731f-44d9-8ff4-ce0ef94f45f4",
    )).toBe(
      "message-retry:event-1:c9c5758f-731f-44d9-8ff4-ce0ef94f45f4",
    );
  });

  it("requires a strict UUID and SHA-256 fingerprint payload", () => {
    expect(messageRetryInputSchema.safeParse({
      clientRequestId: "c9c5758f-731f-44d9-8ff4-ce0ef94f45f4",
      requestFingerprint: "a".repeat(64),
    }).success).toBe(true);
    expect(messageRetryInputSchema.safeParse({
      clientRequestId: "not-a-uuid",
      requestFingerprint: "a".repeat(64),
    }).success).toBe(false);
    expect(messageRetryInputSchema.safeParse({
      clientRequestId: "c9c5758f-731f-44d9-8ff4-ce0ef94f45f4",
      requestFingerprint: "a".repeat(64),
      sourceMessageId: "client-owned-source",
    }).success).toBe(false);
  });
});
