import "server-only";

import { getPrisma } from "@/lib/prisma";
import {
  AttendeePassResolutionError,
  registrationAttendeesSelect,
  serializeAttendee,
} from "@/modules/checkin/attendee-pass-repository";
import {
  ClubPassTokenError,
  clubPassExpiry,
  createClubPassToken,
  verifyClubPassToken,
} from "@/modules/checkin/club-pass-token";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";

const activeStatusSet = new Set<string>(activeRegistrationStatuses);

function tokenError(error: ClubPassTokenError) {
  if (error.code === "PASS_EXPIRED") {
    return new AttendeePassResolutionError(
      "PASS_EXPIRED",
      "This club pass has expired. Search by confirmation code or club name.",
    );
  }
  return new AttendeePassResolutionError(
    "PASS_UNAVAILABLE",
    "This club QR pass is invalid or does not belong to the selected event.",
  );
}

/**
 * Resolves a club's own signed QR pass to its roster (Q1, #412): the same
 * `ResolvedAttendeePass` shape a confirmation-code lookup returns, with no
 * `scannedAttendeeId`, so the scanner opens the plain club view rather than
 * highlighting one person. Waitlisted or cancelled club registrations are
 * refused exactly like the single-attendee eligibility check.
 */
export async function resolveClubPassForEvent(
  eventId: string,
  token: string,
  now = new Date(),
) {
  let claims;
  try {
    claims = verifyClubPassToken(token, { expectedEventId: eventId, now });
  } catch (error) {
    if (error instanceof ClubPassTokenError) throw tokenError(error);
    throw error;
  }

  const clubRegistration = await getPrisma().clubEventRegistration.findFirst({
    where: {
      id: claims.clubRegistrationId,
      eventId,
    },
    select: {
      registration: {
        select: {
          confirmationCode: true,
          status: true,
          attendees: registrationAttendeesSelect,
        },
      },
    },
  });
  if (!clubRegistration) {
    throw new AttendeePassResolutionError(
      "PASS_UNAVAILABLE",
      "This club QR pass is invalid or does not belong to the selected event.",
    );
  }
  if (!activeStatusSet.has(clubRegistration.registration.status)) {
    throw new AttendeePassResolutionError(
      "REGISTRATION_NOT_ELIGIBLE",
      "This club registration is no longer eligible for check-in.",
    );
  }
  return {
    source: "QR_PASS" as const,
    confirmationCode: clubRegistration.registration.confirmationCode,
    attendees: clubRegistration.registration.attendees.map(serializeAttendee),
  };
}

/**
 * Issues the director's own club QR (Q1, #412): only for an active
 * (submitted or confirmed) club registration, so a waitlisted or cancelled
 * club never gets a working pass. Authorization (which club, which
 * director) is the caller's job — `requireRosterAccess` on the route —
 * exactly as the club event page already gates.
 */
export async function createDirectorClubPass(
  organizationId: string,
  eventId: string,
  now = new Date(),
) {
  const record = await getPrisma().clubEventRegistration.findUnique({
    where: { eventId_organizationId: { eventId, organizationId } },
    select: {
      id: true,
      eventId: true,
      registration: { select: { status: true } },
      event: { select: { endsAt: true } },
    },
  });
  if (!record || !activeStatusSet.has(record.registration.status)) return null;

  const expiresAt = clubPassExpiry(record.event.endsAt);
  if (expiresAt.getTime() <= now.getTime()) return null;
  return {
    token: createClubPassToken({
      eventId: record.eventId,
      clubRegistrationId: record.id,
      expiresAt,
    }),
    expiresAt,
  };
}
