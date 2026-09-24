import "server-only";

import { getPrisma } from "@/lib/prisma";
import {
  attendeePassExpiry,
  AttendeePassTokenError,
  createAttendeePassToken,
  verifyAttendeePassToken,
} from "@/modules/checkin/attendee-pass-token";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import { authorizeAttendeeRegistration } from "@/modules/attendee-accounts/registrations-repository";
import { authorizeRegistrationAccessToken } from "@/modules/public-access/repository";

const activeStatusSet = new Set<string>(activeRegistrationStatuses);

export type AttendeePassLookup =
  | { kind: "pass"; value: string }
  | { kind: "confirmation"; value: string };

export type ResolvedAttendeePass = {
  source: "QR_PASS" | "CONFIRMATION_CODE";
  confirmationCode: string;
  attendees: Array<{
    id: string;
    firstName: string;
    lastName: string;
    attendeeType: string;
    checkedIn: boolean;
    checkedInAt: string | null;
  }>;
  /**
   * Q1 (#412): only for a club member's own QR pass, which returns the whole
   * club roster. Names the person actually scanned, so staff check that
   * person in by default instead of the whole club.
   */
  scannedAttendeeId?: string;
};

export class AttendeePassResolutionError extends Error {
  constructor(
    public readonly code:
      | "PASS_UNAVAILABLE"
      | "PASS_EXPIRED"
      | "CONFIRMATION_NOT_FOUND"
      | "REGISTRATION_NOT_ELIGIBLE",
    message: string,
  ) {
    super(message);
    this.name = "AttendeePassResolutionError";
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function attendeeName(
  snapshotValue: unknown,
  person: { firstName: string; lastName: string },
) {
  const snapshot = jsonRecord(snapshotValue);
  return {
    firstName: typeof snapshot.firstName === "string" && snapshot.firstName.trim()
      ? snapshot.firstName.trim()
      : person.firstName,
    lastName: typeof snapshot.lastName === "string" && snapshot.lastName.trim()
      ? snapshot.lastName.trim()
      : person.lastName,
  };
}

export function serializeAttendee(attendee: {
  id: string;
  attendeeType: string;
  profileSnapshot: unknown;
  person: { firstName: string; lastName: string };
  checkIns: Array<{ checkedInAt: Date }>;
}) {
  const name = attendeeName(attendee.profileSnapshot, attendee.person);
  const checkIn = attendee.checkIns[0];
  return {
    id: attendee.id,
    ...name,
    attendeeType: attendee.attendeeType,
    checkedIn: Boolean(checkIn),
    checkedInAt: checkIn?.checkedInAt.toISOString() ?? null,
  };
}

function tokenError(error: AttendeePassTokenError) {
  if (error.code === "PASS_EXPIRED") {
    return new AttendeePassResolutionError(
      "PASS_EXPIRED",
      "This attendee pass has expired. Search by confirmation code or attendee name.",
    );
  }
  return new AttendeePassResolutionError(
    "PASS_UNAVAILABLE",
    "This QR pass is invalid or does not belong to the selected event.",
  );
}

/**
 * Shared with the club pass resolver (`club-pass-repository.ts`) so a club
 * pass roster is serialized identically to an attendee pass roster.
 */
export const registrationAttendeesSelect = {
  orderBy: [{ position: "asc" as const }, { createdAt: "asc" as const }],
  select: {
    id: true,
    attendeeType: true,
    profileSnapshot: true,
    person: {
      select: {
        firstName: true,
        lastName: true,
      },
    },
    checkIns: {
      where: { undoneAt: null },
      orderBy: { checkedInAt: "desc" as const },
      take: 1,
      select: { checkedInAt: true },
    },
  },
};

async function resolveSignedPass(
  eventId: string,
  token: string,
  now: Date,
): Promise<ResolvedAttendeePass> {
  let claims;
  try {
    claims = verifyAttendeePassToken(token, {
      expectedEventId: eventId,
      now,
    });
  } catch (error) {
    if (error instanceof AttendeePassTokenError) throw tokenError(error);
    throw error;
  }

  const attendee = await getPrisma().registrationAttendee.findFirst({
    where: {
      id: claims.attendeeId,
      eventId,
    },
    select: {
      id: true,
      attendeeType: true,
      profileSnapshot: true,
      person: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
      registration: {
        select: {
          id: true,
          confirmationCode: true,
          status: true,
          // Q1 (#412): a club registration's QR pass opens the club's view
          // with the scanned person identified (scannedAttendeeId), so
          // staff can check in that one person or, by explicit choice, the
          // club. Only club membership is checked here; nothing about the
          // club's billing or roster is in the token.
          clubRegistration: { select: { id: true } },
        },
      },
      checkIns: {
        where: { undoneAt: null },
        orderBy: { checkedInAt: "desc" },
        take: 1,
        select: { checkedInAt: true },
      },
    },
  });
  if (!attendee) {
    throw new AttendeePassResolutionError(
      "PASS_UNAVAILABLE",
      "This QR pass is invalid or does not belong to the selected event.",
    );
  }
  if (!activeStatusSet.has(attendee.registration.status)) {
    throw new AttendeePassResolutionError(
      "REGISTRATION_NOT_ELIGIBLE",
      "This registration is no longer eligible for check-in.",
    );
  }
  if (attendee.registration.clubRegistration) {
    const roster = await getPrisma().registrationAttendee.findMany({
      where: { registrationId: attendee.registration.id },
      ...registrationAttendeesSelect,
    });
    return {
      source: "QR_PASS",
      confirmationCode: attendee.registration.confirmationCode,
      attendees: roster.map(serializeAttendee),
      scannedAttendeeId: attendee.id,
    };
  }
  return {
    source: "QR_PASS",
    confirmationCode: attendee.registration.confirmationCode,
    attendees: [serializeAttendee(attendee)],
  };
}

async function resolveConfirmationCode(
  eventId: string,
  confirmationCode: string,
): Promise<ResolvedAttendeePass> {
  const normalizedCode = confirmationCode.trim().toUpperCase();
  const registration = await getPrisma().registration.findUnique({
    where: {
      eventId_confirmationCode: {
        eventId,
        confirmationCode: normalizedCode,
      },
    },
    select: {
      confirmationCode: true,
      status: true,
      attendees: registrationAttendeesSelect,
    },
  });
  if (!registration) {
    throw new AttendeePassResolutionError(
      "CONFIRMATION_NOT_FOUND",
      "No active registration matches that confirmation code for this event.",
    );
  }
  if (!activeStatusSet.has(registration.status)) {
    throw new AttendeePassResolutionError(
      "REGISTRATION_NOT_ELIGIBLE",
      "This registration is no longer eligible for check-in.",
    );
  }
  return {
    source: "CONFIRMATION_CODE",
    confirmationCode: registration.confirmationCode,
    attendees: registration.attendees.map(serializeAttendee),
  };
}

export async function resolveAttendeePassForEvent(
  eventId: string,
  lookup: AttendeePassLookup,
  now = new Date(),
) {
  return lookup.kind === "pass"
    ? resolveSignedPass(eventId, lookup.value.trim(), now)
    : resolveConfirmationCode(eventId, lookup.value);
}

export async function createAuthorizedAttendeePass(
  registrationAccessToken: string,
  attendeeId: string,
  now = new Date(),
) {
  const prisma = getPrisma();
  const access = await authorizeRegistrationAccessToken(
    registrationAccessToken,
    { now, client: prisma },
  );
  if (!access || !activeStatusSet.has(access.registrationStatus)) return null;

  const attendee = await prisma.registrationAttendee.findFirst({
    where: {
      id: attendeeId,
      eventId: access.eventId,
      registrationId: access.registrationId,
    },
    select: {
      id: true,
      eventId: true,
      event: {
        select: { endsAt: true },
      },
    },
  });
  if (!attendee) return null;

  const expiresAt = attendeePassExpiry(attendee.event.endsAt);
  if (expiresAt.getTime() <= now.getTime()) return null;
  return {
    token: createAttendeePassToken({
      eventId: attendee.eventId,
      attendeeId: attendee.id,
      expiresAt,
    }),
    expiresAt,
  };
}

export async function createAccountAttendeePass(
  verifiedEmail: string,
  registrationId: string,
  attendeeId: string,
  now = new Date(),
) {
  const owned = await authorizeAttendeeRegistration(
    verifiedEmail,
    registrationId,
  );
  if (!owned) return null;
  const attendee = await getPrisma().registrationAttendee.findFirst({
    where: {
      id: attendeeId,
      eventId: owned.eventId,
      registrationId: owned.registrationId,
      registration: {
        status: { in: [...activeRegistrationStatuses] },
      },
    },
    select: {
      id: true,
      eventId: true,
      event: { select: { endsAt: true } },
    },
  });
  if (!attendee) return null;
  const expiresAt = attendeePassExpiry(attendee.event.endsAt);
  if (expiresAt.getTime() <= now.getTime()) return null;
  return {
    token: createAttendeePassToken({
      eventId: attendee.eventId,
      attendeeId: attendee.id,
      expiresAt,
    }),
    expiresAt,
  };
}

export async function createStaffAttendeePass(
  eventId: string,
  attendeeId: string,
  now = new Date(),
) {
  const attendee = await getPrisma().registrationAttendee.findFirst({
    where: {
      id: attendeeId,
      eventId,
      registration: {
        status: { in: [...activeRegistrationStatuses] },
      },
    },
    select: {
      id: true,
      eventId: true,
      event: {
        select: { endsAt: true },
      },
    },
  });
  if (!attendee) return null;

  const expiresAt = attendeePassExpiry(attendee.event.endsAt);
  if (expiresAt.getTime() <= now.getTime()) return null;
  return {
    token: createAttendeePassToken({
      eventId: attendee.eventId,
      attendeeId: attendee.id,
      expiresAt,
    }),
    expiresAt,
  };
}
