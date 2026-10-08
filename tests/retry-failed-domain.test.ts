import { describe, expect, it } from "vitest";
import {
  classifyFailedMessage,
  messageBatchKey,
  RETRY_FAILED_SKIP_LABELS,
  retryFailedIdempotencyKey,
  retryFailedPreviewFingerprint,
  retryTreeRoots,
} from "@/modules/communications/retry-failed-domain";

const base = {
  templateKey: "CUSTOM_MESSAGE",
  treeStatuses: [] as string[],
  isNewestFailedInTree: true,
  laterDelivery: false,
  laterQueued: false,
  tooOld: false,
  registrationId: "registration-1" as string | null,
  registrationStatus: "CONFIRMED" as string | null,
  deliveryMode: "EXTERNAL_EMAIL",
  senderEmailSnapshot: "registration@example.test" as string | null,
  settingsSenderEmail: "registration@example.test" as string | null,
};

describe("classifyFailedMessage", () => {
  it("allows the newest failed message of a tree with no success", () => {
    expect(classifyFailedMessage(base)).toBeNull();
    expect(classifyFailedMessage({ ...base, treeStatuses: ["FAILED", "FAILED"] })).toBeNull();
    expect(classifyFailedMessage({ ...base, registrationStatus: "SUBMITTED" })).toBeNull();
    expect(classifyFailedMessage({ ...base, registrationId: null, registrationStatus: null })).toBeNull();
  });

  it("skips when anything in the retry tree was delivered, handled or is queued, however it got there", () => {
    for (const status of ["SENT", "CAPTURED", "SUPPRESSED", "CANCELLED"]) {
      expect(classifyFailedMessage({ ...base, treeStatuses: ["FAILED", status] })).toBe("ALREADY_RETRIED");
    }
    for (const status of ["PENDING", "PROCESSING"]) {
      expect(classifyFailedMessage({ ...base, treeStatuses: [status, "SENT"] })).toBe("ALREADY_QUEUED");
    }
  });

  it("retries only the newest failed message of a tree", () => {
    expect(classifyFailedMessage({ ...base, treeStatuses: ["FAILED"], isNewestFailedInTree: false })).toBe("NEWER_COPY_FAILED");
  });

  it("skips a message whose recipient was sent the same email after it failed", () => {
    expect(classifyFailedMessage({ ...base, laterDelivery: true })).toBe("LATER_DELIVERY");
    expect(classifyFailedMessage({ ...base, laterQueued: true })).toBe("LATER_QUEUED");
    expect(RETRY_FAILED_SKIP_LABELS.LATER_DELIVERY).toContain("same email was sent to the same person");
    expect(RETRY_FAILED_SKIP_LABELS.LATER_QUEUED).toBe("A later send of this email to the same person is already queued");
  });

  it("names the other reasons in priority order", () => {
    expect(classifyFailedMessage({ ...base, templateKey: "INVOICE_DELIVERY" })).toBe("INVOICE");
    expect(classifyFailedMessage({ ...base, templateKey: "CLUB_FORM_LINK" })).toBe("LINK_CLUB_FORM");
    expect(classifyFailedMessage({ ...base, templateKey: "HEALTH_RECORD_LINK" })).toBe("LINK_HEALTH_RECORD");
    expect(classifyFailedMessage({ ...base, templateKey: "NEW_CLUB_APPLICATION_INVITE" })).toBe("LINK_CLUB_INVITE");
    expect(classifyFailedMessage({ ...base, templateKey: "BALANCE_REMINDER" })).toBe("BALANCE_REMINDER");
    expect(RETRY_FAILED_SKIP_LABELS.BALANCE_REMINDER).toContain("Send a fresh balance reminder instead");
    expect(RETRY_FAILED_SKIP_LABELS.LINK_CLUB_FORM).toContain("Club forms");
    expect(RETRY_FAILED_SKIP_LABELS.LINK_HEALTH_RECORD).toContain("Health");
    expect(RETRY_FAILED_SKIP_LABELS.LINK_CLUB_INVITE).toContain("Club applications");
    expect(classifyFailedMessage({ ...base, tooOld: true })).toBe("TOO_OLD");
    expect(classifyFailedMessage({ ...base, registrationStatus: "CANCELLED" })).toBe("REGISTRATION_NOT_ACTIVE");
    expect(classifyFailedMessage({ ...base, registrationStatus: "WAITLISTED" })).toBe("REGISTRATION_NOT_ACTIVE");
    expect(classifyFailedMessage({ ...base, senderEmailSnapshot: " ", settingsSenderEmail: null })).toBe("MISSING_SENDER");
    // A blank snapshot is repaired from the event's sender, so it is not skipped when one is saved.
    expect(classifyFailedMessage({ ...base, senderEmailSnapshot: null })).toBeNull();
    expect(classifyFailedMessage({ ...base, deliveryMode: "LOCAL_CAPTURE", senderEmailSnapshot: null, settingsSenderEmail: null })).toBeNull();
  });
});

describe("retryTreeRoots", () => {
  it("puts a copy, a copy of a copy and a sibling copy in the root's tree", () => {
    const parents = new Map<string, string | null>([
      ["B", "A"], // a bulk copy of A
      ["C", "A"], // a single retry of A: B's sibling
      ["D", "B"], // a copy of B
      ["X", null],
    ]);
    const roots = retryTreeRoots(["A", "B", "C", "D", "X"], parents);
    expect([...roots.entries()]).toEqual([["A", "A"], ["B", "A"], ["C", "A"], ["D", "A"], ["X", "X"]]);
  });

  it("survives a cycle in bad data", () => {
    const roots = retryTreeRoots(["A", "B"], new Map([["A", "B"], ["B", "A"]]));
    expect(roots.size).toBe(2);
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
