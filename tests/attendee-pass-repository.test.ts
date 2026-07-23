import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  authorizeRegistrationAccessToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/public-access/repository", () => ({
  authorizeRegistrationAccessToken:
    dependencies.authorizeRegistrationAccessToken,
}));

import {
  AttendeePassResolutionError,
  createAuthorizedAttendeePass,
  createStaffAttendeePass,
  resolveAttendeePassForEvent,
} from "@/modules/checkin/attendee-pass-repository";
import {
  attendeePassExpiry,
  createAttendeePassToken,
  verifyAttendeePassToken,
} from "@/modules/checkin/attendee-pass-token";

function attendeeRecord(status = "CONFIRMED") {
  return {
    id: "attendee_456",
    attendeeType: "RETREAT_GUEST",
    profileSnapshot: {
      firstName: "Snapshot",
      lastName: "Guest",
      email: "never-return@example.test",
    },
    person: {
      firstName: "Canonical",
      lastName: "Person",
    },
    registration: {
      confirmationCode: "REG-ABC12345",
      status,
    },
    checkIns: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("attendee pass repository", () => {
  it("resolves a valid QR to one active attendee inside the signed event", async () => {
    const findFirst = vi.fn().mockResolvedValue(attendeeRecord());
    dependencies.getPrisma.mockReturnValue({
      registrationAttendee: { findFirst },
    });
    const token = createAttendeePassToken({
      eventId: "event_123",
      attendeeId: "attendee_456",
      expiresAt: new Date("2026-10-13T17:00:00.000Z"),
    });

    const resolution = await resolveAttendeePassForEvent(
      "event_123",
      { kind: "pass", value: token },
      new Date("2026-10-10T12:00:00.000Z"),
    );

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "attendee_456",
        eventId: "event_123",
      },
    }));
    expect(resolution).toEqual({
      source: "QR_PASS",
      confirmationCode: "REG-ABC12345",
      attendees: [{
        id: "attendee_456",
        firstName: "Snapshot",
        lastName: "Guest",
        attendeeType: "RETREAT_GUEST",
        checkedIn: false,
        checkedInAt: null,
      }],
    });
    expect(JSON.stringify(resolution)).not.toContain("never-return@example.test");
  });

  it("rejects a pass for another event before querying attendee data", async () => {
    const findFirst = vi.fn();
    dependencies.getPrisma.mockReturnValue({
      registrationAttendee: { findFirst },
    });
    const token = createAttendeePassToken({
      eventId: "event_123",
      attendeeId: "attendee_456",
      expiresAt: new Date("2026-10-13T17:00:00.000Z"),
    });

    await expect(resolveAttendeePassForEvent(
      "event_other",
      { kind: "pass", value: token },
      new Date("2026-10-10T12:00:00.000Z"),
    )).rejects.toMatchObject({
      code: "PASS_UNAVAILABLE",
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("uses an event-scoped confirmation lookup and returns every party member for review", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      confirmationCode: "REG-ABC12345",
      status: "SUBMITTED",
      attendees: [{
        ...attendeeRecord(),
        checkIns: [{ checkedInAt: new Date("2026-10-10T13:15:00.000Z") }],
      }],
    });
    dependencies.getPrisma.mockReturnValue({
      registration: { findUnique },
    });

    const resolution = await resolveAttendeePassForEvent(
      "event_123",
      { kind: "confirmation", value: " reg-abc12345 " },
    );

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        eventId_confirmationCode: {
          eventId: "event_123",
          confirmationCode: "REG-ABC12345",
        },
      },
    }));
    expect(resolution.attendees[0]).toMatchObject({
      id: "attendee_456",
      checkedIn: true,
      checkedInAt: "2026-10-10T13:15:00.000Z",
    });
  });

  it("blocks cancelled registrations even when their signed QR remains cryptographically valid", async () => {
    dependencies.getPrisma.mockReturnValue({
      registrationAttendee: {
        findFirst: vi.fn().mockResolvedValue(attendeeRecord("CANCELLED")),
      },
    });
    const token = createAttendeePassToken({
      eventId: "event_123",
      attendeeId: "attendee_456",
      expiresAt: new Date("2026-10-13T17:00:00.000Z"),
    });

    await expect(resolveAttendeePassForEvent(
      "event_123",
      { kind: "pass", value: token },
      new Date("2026-10-10T12:00:00.000Z"),
    )).rejects.toBeInstanceOf(AttendeePassResolutionError);
    await expect(resolveAttendeePassForEvent(
      "event_123",
      { kind: "pass", value: token },
      new Date("2026-10-10T12:00:00.000Z"),
    )).rejects.toMatchObject({
      code: "REGISTRATION_NOT_ELIGIBLE",
    });
  });

  it("creates a QR pass only for an attendee covered by the active manage token", async () => {
    const prisma = {
      registrationAttendee: {
        findFirst: vi.fn().mockResolvedValue({
          id: "attendee_456",
          eventId: "event_123",
          event: { endsAt: new Date("2026-10-11T17:00:00.000Z") },
        }),
      },
    };
    dependencies.getPrisma.mockReturnValue(prisma);
    dependencies.authorizeRegistrationAccessToken.mockResolvedValue({
      accessTokenId: "access_1",
      registrationId: "registration_1",
      eventId: "event_123",
      registrationStatus: "CONFIRMED",
    });

    const pass = await createAuthorizedAttendeePass(
      "a".repeat(43),
      "attendee_456",
      new Date("2026-10-10T12:00:00.000Z"),
    );

    expect(prisma.registrationAttendee.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "attendee_456",
          eventId: "event_123",
          registrationId: "registration_1",
        },
      }),
    );
    expect(pass?.expiresAt).toEqual(attendeePassExpiry(
      new Date("2026-10-11T17:00:00.000Z"),
    ));
    expect(verifyAttendeePassToken(pass!.token, {
      expectedEventId: "event_123",
      now: new Date("2026-10-10T12:00:00.000Z"),
    }).attendeeId).toBe("attendee_456");

    dependencies.authorizeRegistrationAccessToken.mockResolvedValueOnce(null);
    await expect(createAuthorizedAttendeePass(
      "b".repeat(43),
      "attendee_456",
    )).resolves.toBeNull();
  });

  it("creates an event-scoped staff pass only for an active attendee before expiry", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "attendee_456",
      eventId: "event_123",
      event: { endsAt: new Date("2026-10-11T17:00:00.000Z") },
    });
    dependencies.getPrisma.mockReturnValue({
      registrationAttendee: { findFirst },
    });

    const pass = await createStaffAttendeePass(
      "event_123",
      "attendee_456",
      new Date("2026-10-10T12:00:00.000Z"),
    );

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "attendee_456",
        eventId: "event_123",
        registration: {
          status: { in: ["SUBMITTED", "CONFIRMED"] },
        },
      },
    }));
    expect(verifyAttendeePassToken(pass!.token, {
      expectedEventId: "event_123",
      now: new Date("2026-10-10T12:00:00.000Z"),
    }).attendeeId).toBe("attendee_456");

    findFirst.mockResolvedValueOnce(null);
    await expect(createStaffAttendeePass(
      "event_123",
      "attendee_other",
    )).resolves.toBeNull();

    findFirst.mockResolvedValueOnce({
      id: "attendee_456",
      eventId: "event_123",
      event: { endsAt: new Date("2026-10-01T17:00:00.000Z") },
    });
    await expect(createStaffAttendeePass(
      "event_123",
      "attendee_456",
      new Date("2026-10-04T17:00:00.000Z"),
    )).resolves.toBeNull();
  });
});
