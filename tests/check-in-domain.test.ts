import { describe, expect, it } from "vitest";
import {
  checkInQueueItemAfterOfflineRetry,
  checkInRequestSchema,
  inspectOfflineCheckInQueue,
  offlineCheckInErrorMessage,
  offlineCheckInStorageKey,
  parseOfflineCheckInQueue,
  queueItemForCheckIn,
  updateQueuedCheckIn,
} from "@/modules/checkin/domain";

const idempotencyKey = "d67776d0-f79d-4e8f-bec2-ee61abb7337c";

describe("check-in request and offline queue domain", () => {
  it("accepts one strict UUID idempotency key and rejects extra fields", () => {
    expect(checkInRequestSchema.parse({ idempotencyKey })).toEqual({
      idempotencyKey,
    });
    expect(checkInRequestSchema.safeParse({
      idempotencyKey: "not-a-uuid",
    }).success).toBe(false);
    expect(checkInRequestSchema.safeParse({
      idempotencyKey,
      attendeeName: "Do not persist me",
    }).success).toBe(false);
  });

  it("creates event-scoped storage containing only opaque action metadata", () => {
    const item = queueItemForCheckIn(
      "attendee_123",
      idempotencyKey,
      new Date("2026-07-23T14:00:00.000Z"),
    );

    expect(offlineCheckInStorageKey("event_123")).toBe(
      "imsda-events:check-in-queue:v1:event_123",
    );
    expect(item).toEqual({
      operation: "CHECK_IN",
      attendeeId: "attendee_123",
      idempotencyKey,
      queuedAt: "2026-07-23T14:00:00.000Z",
      attempts: 0,
      state: "QUEUED",
      lastErrorCode: "NETWORK_UNAVAILABLE",
    });
    expect(JSON.stringify(item)).not.toMatch(
      /name|email|phone|confirmationCode|payment/i,
    );
  });

  it("keeps valid saved conflicts recoverable and rejects injected PII fields", () => {
    const queued = queueItemForCheckIn(
      "attendee_123",
      idempotencyKey,
      new Date("2026-07-23T14:00:00.000Z"),
    );
    const conflict = updateQueuedCheckIn(queued, {
      state: "CONFLICT",
      lastErrorCode: "REGISTRATION_NOT_ELIGIBLE",
    });

    expect(parseOfflineCheckInQueue(JSON.stringify([conflict]))).toEqual([
      conflict,
    ]);
    expect(offlineCheckInErrorMessage(conflict.lastErrorCode)).toContain(
      "cancelled",
    );
    expect(parseOfflineCheckInQueue(JSON.stringify([{
      ...conflict,
      attendeeName: "Must not be stored",
    }]))).toEqual([]);
  });

  it("recovers safely from malformed local storage", () => {
    expect(parseOfflineCheckInQueue("{not json")).toEqual([]);
    expect(parseOfflineCheckInQueue(JSON.stringify({ queue: [] }))).toEqual(
      [],
    );
    expect(inspectOfflineCheckInQueue("{not json")).toEqual({
      items: [],
      invalidItemCount: 1,
    });
  });

  it("reports malformed rows without exposing them or silently downgrading conflicts", () => {
    const queued = queueItemForCheckIn(
      "attendee_123",
      idempotencyKey,
      new Date("2026-07-23T14:00:00.000Z"),
    );
    const conflict = updateQueuedCheckIn(queued, {
      state: "CONFLICT",
      lastErrorCode: "ATTENDEE_NOT_FOUND",
    });
    const inspection = inspectOfflineCheckInQueue(JSON.stringify([
      conflict,
      { operation: "CHECK_IN", attendeeName: "Malformed private data" },
    ]));

    expect(inspection).toEqual({
      items: [conflict],
      invalidItemCount: 1,
    });
    expect(checkInQueueItemAfterOfflineRetry(conflict)).toBe(conflict);
    expect(checkInQueueItemAfterOfflineRetry(conflict)).toMatchObject({
      state: "CONFLICT",
      lastErrorCode: "ATTENDEE_NOT_FOUND",
      attempts: 1,
    });
  });
});
