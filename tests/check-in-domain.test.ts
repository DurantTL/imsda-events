import { describe, expect, it } from "vitest";
import {
  arrivalMatchesSearch,
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

describe("check-in search (#441)", () => {
  const samantha = { firstName: "Samantha", lastName: "Rivera", confirmationCode: "WR26-AB12" };
  const jose = { firstName: "José", lastName: "Núñez", confirmationCode: "WR26-AB12" };

  it("matches first or last name by prefix, ignoring case and accents", () => {
    expect(arrivalMatchesSearch(samantha, "sam")).toBe(true);
    expect(arrivalMatchesSearch(samantha, "RIV")).toBe(true);
    expect(arrivalMatchesSearch(samantha, "sam riv")).toBe(true);
    expect(arrivalMatchesSearch(jose, "jose nunez")).toBe(true);
    expect(arrivalMatchesSearch(samantha, "antha")).toBe(false);
    expect(arrivalMatchesSearch(samantha, "sam nunez")).toBe(false);
  });

  it("finds hyphenated, apostrophe, and non-Latin names", () => {
    const code = { confirmationCode: "WR26-CD34" };
    expect(arrivalMatchesSearch({ ...code, firstName: "Mary-Jane", lastName: "O'Brien" }, "jane")).toBe(true);
    expect(arrivalMatchesSearch({ ...code, firstName: "Mary-Jane", lastName: "O'Brien" }, "o'bri")).toBe(true);
    expect(arrivalMatchesSearch({ ...code, firstName: "Søren", lastName: "Ødegaard" }, "ødeg")).toBe(true);
    expect(arrivalMatchesSearch({ ...code, firstName: "Мария", lastName: "Иванова" }, "иван")).toBe(true);
    expect(arrivalMatchesSearch({ ...code, firstName: "Mary-Jane", lastName: "O'Brien" }, "obrien")).toBe(true);
    expect(arrivalMatchesSearch({ ...code, firstName: "Mary-Jane", lastName: "O’Brien" }, "maryjane")).toBe(true);
    expect(arrivalMatchesSearch({ ...code, firstName: "Łukasz", lastName: "Søndergård" }, "lukasz sonder")).toBe(true);
  });

  it("doesn't list everyone while the start of a name matches the code's letters", () => {
    expect(arrivalMatchesSearch(samantha, "w")).toBe(false);
    expect(arrivalMatchesSearch(samantha, "wr")).toBe(false);
    expect(arrivalMatchesSearch(samantha, "wr26")).toBe(true);
    expect(arrivalMatchesSearch(samantha, "WR26-AB")).toBe(true);
  });

  it("matches a name and club together", () => {
    expect(arrivalMatchesSearch(samantha, "sam trail", "Trailblazers Pathfinders")).toBe(true);
    expect(arrivalMatchesSearch(samantha, "sam eagles", "Trailblazers Pathfinders")).toBe(false);
  });

  it("does not match the registration's email, so a shared email doesn't list everyone", () => {
    // The search never receives the email; typing one matches no name.
    expect(arrivalMatchesSearch(samantha, "family@example.test")).toBe(false);
    expect(arrivalMatchesSearch(jose, "family@example.test")).toBe(false);
  });

  it("still matches the confirmation code and club name", () => {
    expect(arrivalMatchesSearch(samantha, "ab12")).toBe(true);
    expect(arrivalMatchesSearch(samantha, "blazers", "Trailblazers Pathfinders")).toBe(false);
    expect(arrivalMatchesSearch(samantha, "trail", "Trailblazers Pathfinders")).toBe(true);
    expect(arrivalMatchesSearch(samantha, "")).toBe(true);
  });
});
