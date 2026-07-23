import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  attendeePassExpiry,
  attendeePassIsAvailable,
  AttendeePassTokenError,
  createAttendeePassToken,
  verifyAttendeePassToken,
} from "@/modules/checkin/attendee-pass-token";

const currentSecret = "current-test-attendee-pass-secret-with-32-characters";
const previousSecret = "previous-test-attendee-pass-secret-with-32-characters";
const productionSource = {
  NODE_ENV: "production",
  ATTENDEE_PASS_SIGNING_SECRET: currentSecret,
};

function createToken(
  source: Record<string, string | undefined> = productionSource,
) {
  return createAttendeePassToken({
    eventId: "event_123",
    attendeeId: "attendee_456",
    expiresAt: new Date("2026-10-13T17:00:00.000Z"),
  }, source);
}

describe("attendee pass tokens", () => {
  it("round-trips signed, event-scoped claims without encoding PII", () => {
    const token = createToken();
    const claims = verifyAttendeePassToken(token, {
      expectedEventId: "event_123",
      now: new Date("2026-10-10T12:00:00.000Z"),
      source: productionSource,
    });
    const encodedPayload = token.split(".")[2];
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );

    expect(claims).toEqual({
      version: 1,
      eventId: "event_123",
      attendeeId: "attendee_456",
      expiresAt: new Date("2026-10-13T17:00:00.000Z"),
    });
    expect(payload).toEqual({
      v: 1,
      e: "event_123",
      a: "attendee_456",
      x: new Date("2026-10-13T17:00:00.000Z").getTime() / 1_000,
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /name|email|phone|payment|confirmation/i,
    );
  });

  it("rejects tampering, another event, and an expired pass", () => {
    const token = createToken();
    const parts = token.split(".");
    const tampered = [...parts.slice(0, 2), `${parts[2]}a`, parts[3]].join(".");

    expect(() => verifyAttendeePassToken(tampered, {
      expectedEventId: "event_123",
      source: productionSource,
    })).toThrowError(AttendeePassTokenError);
    expect(() => verifyAttendeePassToken(token, {
      expectedEventId: "another_event",
      now: new Date("2026-10-10T12:00:00.000Z"),
      source: productionSource,
    })).toThrowError(expect.objectContaining({ code: "PASS_EVENT_MISMATCH" }));
    expect(() => verifyAttendeePassToken(token, {
      expectedEventId: "event_123",
      now: new Date("2026-10-13T17:00:00.000Z"),
      source: productionSource,
    })).toThrowError(expect.objectContaining({ code: "PASS_EXPIRED" }));
  });

  it("accepts the previous secret during a bounded rotation overlap", () => {
    const oldToken = createToken({
      NODE_ENV: "production",
      ATTENDEE_PASS_SIGNING_SECRET: previousSecret,
    });

    expect(verifyAttendeePassToken(oldToken, {
      expectedEventId: "event_123",
      now: new Date("2026-10-10T12:00:00.000Z"),
      source: {
        NODE_ENV: "production",
        ATTENDEE_PASS_SIGNING_SECRET: currentSecret,
        ATTENDEE_PASS_SIGNING_SECRET_PREVIOUS: previousSecret,
      },
    }).attendeeId).toBe("attendee_456");
  });

  it("requires a strong production secret and expires 48 hours after the event", () => {
    expect(() => createToken({
      NODE_ENV: "production",
      ATTENDEE_PASS_SIGNING_SECRET: "too-short",
    })).toThrowError(expect.objectContaining({
      code: "PASS_CONFIGURATION_INVALID",
    }));
    expect(attendeePassExpiry(
      new Date("2026-10-11T17:00:00.000Z"),
    ).toISOString()).toBe("2026-10-13T17:00:00.000Z");
    expect(attendeePassIsAvailable(
      new Date("2026-10-11T17:00:00.000Z"),
      new Date("2026-10-13T16:59:59.999Z"),
    )).toBe(true);
    expect(attendeePassIsAvailable(
      new Date("2026-10-11T17:00:00.000Z"),
      new Date("2026-10-13T17:00:00.000Z"),
    )).toBe(false);
  });
});
