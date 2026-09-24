import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  clubPassExpiry,
  clubPassIsAvailable,
  ClubPassTokenError,
  createClubPassToken,
  verifyClubPassToken,
} from "@/modules/checkin/club-pass-token";
import {
  attendeePassExpiry,
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
  return createClubPassToken({
    eventId: "event_123",
    clubRegistrationId: "club_reg_456",
    expiresAt: new Date("2026-10-13T17:00:00.000Z"),
  }, source);
}

describe("club pass tokens (#412)", () => {
  it("round-trips signed, event-scoped claims naming the club registration, not a person", () => {
    const token = createToken();
    const claims = verifyClubPassToken(token, {
      expectedEventId: "event_123",
      now: new Date("2026-10-10T12:00:00.000Z"),
      source: productionSource,
    });
    const [namespace, version, encodedPayload] = token.split(".");
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );

    expect(namespace).toBe("imsda-club-pass");
    expect(version).toBe("v1");
    expect(claims).toEqual({
      version: 1,
      type: "club",
      eventId: "event_123",
      clubRegistrationId: "club_reg_456",
      expiresAt: new Date("2026-10-13T17:00:00.000Z"),
    });
    expect(payload).toEqual({
      v: 1,
      t: "club",
      e: "event_123",
      c: "club_reg_456",
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

    expect(() => verifyClubPassToken(tampered, {
      expectedEventId: "event_123",
      source: productionSource,
    })).toThrowError(ClubPassTokenError);
    expect(() => verifyClubPassToken(token, {
      expectedEventId: "another_event",
      now: new Date("2026-10-10T12:00:00.000Z"),
      source: productionSource,
    })).toThrowError(expect.objectContaining({ code: "PASS_EVENT_MISMATCH" }));
    expect(() => verifyClubPassToken(token, {
      expectedEventId: "event_123",
      now: new Date("2026-10-13T17:00:00.000Z"),
      source: productionSource,
    })).toThrowError(expect.objectContaining({ code: "PASS_EXPIRED" }));
  });

  it("accepts the previous secret during a bounded rotation overlap, sharing the attendee pass's mechanism", () => {
    const oldToken = createToken({
      NODE_ENV: "production",
      ATTENDEE_PASS_SIGNING_SECRET: previousSecret,
    });

    expect(verifyClubPassToken(oldToken, {
      expectedEventId: "event_123",
      now: new Date("2026-10-10T12:00:00.000Z"),
      source: {
        NODE_ENV: "production",
        ATTENDEE_PASS_SIGNING_SECRET: currentSecret,
        ATTENDEE_PASS_SIGNING_SECRET_PREVIOUS: previousSecret,
      },
    }).clubRegistrationId).toBe("club_reg_456");
  });

  it("requires a strong production secret and expires 48 hours after the event, exactly as an attendee pass does", () => {
    expect(() => createToken({
      NODE_ENV: "production",
      ATTENDEE_PASS_SIGNING_SECRET: "too-short",
    })).toThrowError(expect.objectContaining({
      code: "PASS_CONFIGURATION_INVALID",
    }));
    expect(clubPassExpiry(
      new Date("2026-10-11T17:00:00.000Z"),
    ).toISOString()).toBe("2026-10-13T17:00:00.000Z");
    expect(clubPassIsAvailable(
      new Date("2026-10-11T17:00:00.000Z"),
      new Date("2026-10-13T16:59:59.999Z"),
    )).toBe(true);
    expect(clubPassIsAvailable(
      new Date("2026-10-11T17:00:00.000Z"),
      new Date("2026-10-13T17:00:00.000Z"),
    )).toBe(false);
    expect(clubPassExpiry(new Date("2026-10-11T17:00:00.000Z")))
      .toEqual(attendeePassExpiry(new Date("2026-10-11T17:00:00.000Z")));
  });

  it("can never be mistaken for an attendee pass, in either direction, even though both share a signing secret", () => {
    const clubToken = createToken();
    const attendeeToken = createAttendeePassToken({
      eventId: "event_123",
      attendeeId: "attendee_456",
      expiresAt: new Date("2026-10-13T17:00:00.000Z"),
    }, productionSource);

    // An attendee pass presented where a club pass is expected.
    expect(() => verifyClubPassToken(attendeeToken, {
      expectedEventId: "event_123",
      now: new Date("2026-10-10T12:00:00.000Z"),
      source: productionSource,
    })).toThrowError(expect.objectContaining({ code: "PASS_MALFORMED" }));

    // A club pass presented where an attendee pass is expected.
    expect(() => verifyAttendeePassToken(clubToken, {
      expectedEventId: "event_123",
      now: new Date("2026-10-10T12:00:00.000Z"),
      source: productionSource,
    })).toThrowError(expect.objectContaining({ code: "PASS_MALFORMED" }));
  });
});
