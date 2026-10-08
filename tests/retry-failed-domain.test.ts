import { describe, expect, it } from "vitest";
import {
  classifyFailedMessage,
  messageBatchKey,
  retryFailedIdempotencyKey,
  retryFailedPreviewFingerprint,
} from "@/modules/communications/retry-failed-domain";

const base = {
  templateKey: "CUSTOM_MESSAGE",
  retryStatuses: [] as string[],
  registrationId: "registration-1",
  registrationStatus: "CONFIRMED",
  deliveryMode: "EXTERNAL_EMAIL",
  senderEmailSnapshot: "registration@example.test",
  settingsSenderEmail: "registration@example.test",
};

describe("classifyFailedMessage", () => {
  it("allows a failed message with no copy and an active registration", () => {
    expect(classifyFailedMessage(base)).toBeNull();
    expect(classifyFailedMessage({ ...base, registrationStatus: "SUBMITTED" })).toBeNull();
    expect(classifyFailedMessage({ ...base, registrationId: null, registrationStatus: null })).toBeNull();
  });

  it("names why a message is skipped, in priority order", () => {
    expect(classifyFailedMessage({ ...base, templateKey: "INVOICE_DELIVERY" })).toBe("INVOICE");
    expect(classifyFailedMessage({ ...base, retryStatuses: ["FAILED", "PENDING"] })).toBe("ALREADY_QUEUED");
    expect(classifyFailedMessage({ ...base, retryStatuses: ["PROCESSING"] })).toBe("ALREADY_QUEUED");
    expect(classifyFailedMessage({ ...base, retryStatuses: ["SENT"] })).toBe("ALREADY_RETRIED");
    expect(classifyFailedMessage({ ...base, retryStatuses: ["CAPTURED"] })).toBe("ALREADY_RETRIED");
    expect(classifyFailedMessage({ ...base, retryStatuses: ["FAILED"] })).toBe("NEWER_COPY_FAILED");
    expect(classifyFailedMessage({ ...base, registrationStatus: "CANCELLED" })).toBe("REGISTRATION_NOT_ACTIVE");
    expect(classifyFailedMessage({ ...base, registrationStatus: "WAITLISTED" })).toBe("REGISTRATION_NOT_ACTIVE");
    expect(classifyFailedMessage({ ...base, senderEmailSnapshot: " ", settingsSenderEmail: null })).toBe("MISSING_SENDER");
    // A blank snapshot is repaired from the event's sender, so it is not skipped when one is saved.
    expect(classifyFailedMessage({ ...base, senderEmailSnapshot: null })).toBeNull();
    expect(classifyFailedMessage({ ...base, deliveryMode: "LOCAL_CAPTURE", senderEmailSnapshot: null, settingsSenderEmail: null })).toBeNull();
  });
});

describe("retry-failed fingerprint and keys", () => {
  const input = { eventId: "event-1", scope: { type: "EVENT" as const }, deliveryMode: "EXTERNAL_EMAIL", queueMessageIds: ["b", "a"], eligibleCount: 2 };

  it("is stable regardless of order and changes with the set, scope, mode or event", () => {
    const fingerprint = retryFailedPreviewFingerprint(input);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(retryFailedPreviewFingerprint({ ...input, queueMessageIds: ["a", "b"] })).toBe(fingerprint);
    expect(retryFailedPreviewFingerprint({ ...input, queueMessageIds: ["a"] })).not.toBe(fingerprint);
    expect(retryFailedPreviewFingerprint({ ...input, eligibleCount: 3 })).not.toBe(fingerprint);
    expect(retryFailedPreviewFingerprint({ ...input, scope: { type: "BATCH", batchId: "x" } })).not.toBe(fingerprint);
    expect(retryFailedPreviewFingerprint({ ...input, deliveryMode: "LOCAL_CAPTURE" })).not.toBe(fingerprint);
    expect(retryFailedPreviewFingerprint({ ...input, eventId: "event-2" })).not.toBe(fingerprint);
  });

  it("derives one idempotency key per request and source message", () => {
    expect(retryFailedIdempotencyKey("event-1", "req-1", "m1")).toBe("message-retry-failed:event-1:req-1:m1");
    expect(retryFailedIdempotencyKey("event-1", "req-1", "m1")).not.toBe(retryFailedIdempotencyKey("event-1", "req-1", "m2"));
    expect(retryFailedIdempotencyKey("event-1", "req-1", "m1")).not.toBe(retryFailedIdempotencyKey("event-1", "req-2", "m1"));
  });

  it("reads the batch from metadata, falling back to a retry copy's source batch", () => {
    expect(messageBatchKey({ metadata: { batchId: "b1" } })).toBe("b1");
    expect(messageBatchKey({ metadata: { sourceBatchId: "b2" } })).toBe("b2");
    expect(messageBatchKey({ metadata: { batchId: "b1", sourceBatchId: "b2" } })).toBe("b1");
    expect(messageBatchKey({ metadata: null })).toBeNull();
    expect(messageBatchKey({ metadata: ["b1"] })).toBeNull();
  });
});
