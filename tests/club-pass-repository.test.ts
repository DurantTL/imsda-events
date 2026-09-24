import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { AttendeePassResolutionError } from "@/modules/checkin/attendee-pass-repository";
import {
  createDirectorClubPass,
  resolveClubPassForEvent,
} from "@/modules/checkin/club-pass-repository";
import {
  createClubPassToken,
  verifyClubPassToken,
} from "@/modules/checkin/club-pass-token";

function rosterRow(overrides: Partial<{
  id: string;
  attendeeType: string;
  profileSnapshot: unknown;
  person: { firstName: string; lastName: string };
  checkIns: Array<{ checkedInAt: Date }>;
}> = {}) {
  return {
    id: "attendee_1",
    attendeeType: "YOUTH",
    profileSnapshot: { firstName: "Riley", lastName: "Roamer" },
    person: { firstName: "Riley", lastName: "Roamer" },
    checkIns: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("club pass repository (#412)", () => {
  it("resolves a club's own QR to the whole roster, with no scanned person", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      registration: {
        confirmationCode: "REG-CLUB123",
        status: "CONFIRMED",
        attendees: [
          rosterRow({ id: "attendee_1" }),
          rosterRow({
            id: "attendee_2",
            attendeeType: "ADULT_LEADER",
            profileSnapshot: { firstName: "Sam", lastName: "Scout" },
            person: { firstName: "Sam", lastName: "Scout" },
            checkIns: [{ checkedInAt: new Date("2026-10-10T13:00:00.000Z") }],
          }),
        ],
      },
    });
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findFirst },
    });
    const token = createClubPassToken({
      eventId: "event_123",
      clubRegistrationId: "club_reg_1",
      expiresAt: new Date("2026-10-13T17:00:00.000Z"),
    });

    const resolution = await resolveClubPassForEvent(
      "event_123",
      token,
      new Date("2026-10-10T12:00:00.000Z"),
    );

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "club_reg_1", eventId: "event_123" },
    }));
    expect(resolution).toEqual({
      source: "QR_PASS",
      confirmationCode: "REG-CLUB123",
      attendees: [
        {
          id: "attendee_1",
          firstName: "Riley",
          lastName: "Roamer",
          attendeeType: "YOUTH",
          checkedIn: false,
          checkedInAt: null,
        },
        {
          id: "attendee_2",
          firstName: "Sam",
          lastName: "Scout",
          attendeeType: "ADULT_LEADER",
          checkedIn: true,
          checkedInAt: "2026-10-10T13:00:00.000Z",
        },
      ],
    });
    // Unlike an attendee's own club-member pass, a club pass never names a
    // scanned person: it opens the plain club view.
    expect(Object.keys(resolution)).not.toContain("scannedAttendeeId");
  });

  it("rejects a club pass for another event before querying the registration", async () => {
    const findFirst = vi.fn();
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findFirst },
    });
    const token = createClubPassToken({
      eventId: "event_123",
      clubRegistrationId: "club_reg_1",
      expiresAt: new Date("2026-10-13T17:00:00.000Z"),
    });

    await expect(resolveClubPassForEvent(
      "event_other",
      token,
      new Date("2026-10-10T12:00:00.000Z"),
    )).rejects.toMatchObject({ code: "PASS_UNAVAILABLE" });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("blocks a waitlisted or cancelled club registration even with a cryptographically valid pass", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      registration: { confirmationCode: "REG-CLUB123", status: "WAITLISTED", attendees: [] },
    });
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findFirst },
    });
    const token = createClubPassToken({
      eventId: "event_123",
      clubRegistrationId: "club_reg_1",
      expiresAt: new Date("2026-10-13T17:00:00.000Z"),
    });

    await expect(resolveClubPassForEvent(
      "event_123",
      token,
      new Date("2026-10-10T12:00:00.000Z"),
    )).rejects.toBeInstanceOf(AttendeePassResolutionError);
    await expect(resolveClubPassForEvent(
      "event_123",
      token,
      new Date("2026-10-10T12:00:00.000Z"),
    )).rejects.toMatchObject({ code: "REGISTRATION_NOT_ELIGIBLE" });
  });

  it("creates a director's club pass only for an active club registration before expiry", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: "club_reg_1",
      eventId: "event_123",
      registration: { status: "CONFIRMED" },
      event: { endsAt: new Date("2026-10-11T17:00:00.000Z") },
    });
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findUnique },
    });

    const pass = await createDirectorClubPass(
      "org_1",
      "event_123",
      new Date("2026-10-10T12:00:00.000Z"),
    );

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { eventId_organizationId: { eventId: "event_123", organizationId: "org_1" } },
    }));
    expect(verifyClubPassToken(pass!.token, {
      expectedEventId: "event_123",
      now: new Date("2026-10-10T12:00:00.000Z"),
    }).clubRegistrationId).toBe("club_reg_1");

    findUnique.mockResolvedValueOnce(null);
    await expect(createDirectorClubPass("org_other", "event_123")).resolves.toBeNull();

    findUnique.mockResolvedValueOnce({
      id: "club_reg_1",
      eventId: "event_123",
      registration: { status: "WAITLISTED" },
      event: { endsAt: new Date("2026-10-11T17:00:00.000Z") },
    });
    await expect(createDirectorClubPass("org_1", "event_123")).resolves.toBeNull();

    findUnique.mockResolvedValueOnce({
      id: "club_reg_1",
      eventId: "event_123",
      registration: { status: "CONFIRMED" },
      event: { endsAt: new Date("2026-10-01T17:00:00.000Z") },
    });
    await expect(createDirectorClubPass(
      "org_1",
      "event_123",
      new Date("2026-10-04T17:00:00.000Z"),
    )).resolves.toBeNull();
  });
});
