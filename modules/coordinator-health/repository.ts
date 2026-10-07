import "server-only";

import { teamLabel } from "@/modules/club-teams/domain";
import { getPrisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";
import { isSecretEncryptionConfigured, SecretBoxError } from "@/lib/secret-box";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { openSensitiveAnswers } from "@/modules/club-forms/sealed-answers";
import {
  ACTIVITY_DATE_KEY,
  dietaryFromResponses,
  eventCalendarDates,
  healthAuditActor,
  healthWindowEndsOn,
  healthWindowOpen,
  HEALTH_FORM_KEYS,
  medicalFlagFromResponses,
  normalizeName,
  passengerContacts,
  pickHealthAnswers,
  passengerEmergencyKey,
  passengerNameKey,
  PASSENGER_LIST_KEY,
  PASSENGER_SLOTS,
  PERMISSION_SLIP_KEY,
  slipContact,
  SLIP_EMERGENCY_KEY,
  sortAttendees,
  sortContacts,
  type EmergencyStatus,
  viewerCanSeeClub,
  viewerCanSeeEvent,
  type EmergencyContact,
  type HealthAttendeeRow,
  type HealthClubSheet,
  type HealthViewer,
} from "@/modules/coordinator-health/domain";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";

export class HealthViewError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "FORBIDDEN" | "WINDOW_CLOSED" | "ENCRYPTION_UNAVAILABLE" | "SENSITIVE_UNREADABLE",
    message: string,
  ) {
    super(message);
    this.name = "HealthViewError";
  }
}

export type HealthPurpose = "VIEW" | "EXPORT";

const WINDOW_CLOSED_MESSAGE = "The health information for this event is no longer available. It is hidden 30 days after the event ends.";

/** Years a club's forms could cover for the event: the club year of its first and last day. */
function clubYearsFor(event: { startsAt: Date; endsAt: Date }) {
  return [...new Set([clubYearFor(event.startsAt), clubYearFor(event.endsAt)])];
}

/**
 * Club events a viewer may open right now: the window is still open and the
 * viewer's scope covers them. Lists names and dates only, never health data.
 */
export async function listHealthEvents(viewer: HealthViewer, now = new Date()) {
  const events = await getPrisma().event.findMany({
    where: {
      clubRegistrations: {
        some: viewer.kind === "CLUB_LEADER" ? { organizationId: viewer.organizationId } : {},
      },
      // A day of slack either side of 30 days; the exact window is applied below in the event's time zone.
      endsAt: { gte: new Date(now.getTime() - 32 * 86_400_000) },
      ...(viewer.kind === "HEALTH_ROLE" ? { id: { in: [...viewer.eventIds] } } : {}),
    },
    orderBy: { startsAt: "desc" },
    take: 100,
    select: { id: true, name: true, startsAt: true, endsAt: true, timezone: true },
  });
  return events
    .filter((event) => viewerCanSeeEvent(viewer, event.id) && healthWindowOpen(event, now))
    .map((event) => ({
      id: event.id,
      name: event.name,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      availableThrough: healthWindowEndsOn(event),
    }));
}

export type HealthEventSheet = {
  event: { id: string; name: string; startsAt: string; endsAt: string; availableThrough: string };
  purpose: HealthPurpose;
  clubs: HealthClubSheet[];
};

/**
 * One club event's health sheet for a viewer. The access check, the window
 * check and the audit row all come before any sealed value is opened; if the
 * audit write fails nothing is returned. The audit row carries who, which
 * event, which club (if narrowed), how many people and whether it was a view
 * or an export, and no health text.
 */
export async function loadEventHealth(
  viewer: HealthViewer,
  eventId: string,
  options: { organizationId?: string; purpose?: HealthPurpose } = {},
  now = new Date(),
): Promise<HealthEventSheet> {
  const purpose = options.purpose ?? "VIEW";
  const prisma = getPrisma();
  const requestedClub = viewer.kind === "CLUB_LEADER" ? viewer.organizationId : options.organizationId;
  const who = healthAuditActor(viewer);
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, startsAt: true, endsAt: true, timezone: true },
  });

  // Ids are short opaque strings. Anything else is caller-supplied text and is never stored.
  const idShaped = (value: string | undefined | null): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

  /** A refused attempt is audited too (ADR 0005 section 3): who, event, why, never any health text. */
  async function deny(code: HealthViewError["code"], message: string): Promise<never> {
    try {
      await writeAuditLog({
        ...(event ? { eventId: event.id } : {}),
        actorUserId: who.actorUserId,
        action: "COORDINATOR_HEALTH_DENIED",
        entityType: "Event",
        entityId: idShaped(eventId) ? eventId : "unknown",
        summary: "A coordinator health view request was refused.",
        metadata: { ...who.metadata, purpose, reason: code, organizationId: options.organizationId === undefined ? null : idShaped(options.organizationId) ? options.organizationId : "invalid" },
      });
    } catch (error) {
      // The refusal stands even if the audit write fails. Nothing health-related is in this log line.
      logError("Coordinator health denial could not be audited", error);
    }
    throw new HealthViewError(code, message);
  }

  if (!viewerCanSeeEvent(viewer, eventId)) return deny("FORBIDDEN", "You don't have health access for this event.");
  if (options.organizationId && !viewerCanSeeClub(viewer, options.organizationId)) {
    return deny("NOT_FOUND", "That club could not be found.");
  }
  if (!event) return deny("NOT_FOUND", "That event could not be found.");
  if (!healthWindowOpen(event, now)) return deny("WINDOW_CLOSED", WINDOW_CLOSED_MESSAGE);

  const registrations = await prisma.clubEventRegistration.findMany({
    where: {
      eventId,
      ...(requestedClub ? { organizationId: requestedClub } : {}),
      registration: { status: { in: [...activeRegistrationStatuses] } },
    },
    orderBy: [{ organization: { name: "asc" } }, { teamKey: "asc" }],
    select: {
      teamKey: true,
      teamName: true,
      organization: { select: { id: true, name: true } },
      registration: {
        select: {
          attendees: {
            orderBy: { position: "asc" },
            select: { id: true, personId: true, formResponses: true, person: { select: { firstName: true, lastName: true } } },
          },
        },
      },
    },
  });
  const attendeeCount = registrations.reduce((total, row) => total + row.registration.attendees.length, 0);

  // Audit first. Nothing sealed is opened, and nothing is returned, if this fails.
  await writeAuditLog({
    eventId,
    actorUserId: who.actorUserId,
    action: purpose === "EXPORT" ? "COORDINATOR_HEALTH_EXPORTED" : "COORDINATOR_HEALTH_VIEWED",
    entityType: "Event",
    entityId: eventId,
    summary: purpose === "EXPORT"
      ? "Printed the confidential emergency sheet for a club event."
      : "Opened the coordinator health view for a club event.",
    metadata: {
      ...who.metadata,
      purpose,
      organizationId: requestedClub ?? null,
      clubCount: registrations.length,
      attendeeCount,
    },
  });

  const organizationIds = registrations.map((row) => row.organization.id);
  const personIds = registrations.flatMap((row) => row.registration.attendees.map((attendee) => attendee.personId));
  const years = clubYearsFor(event);
  const [rosterMembers, submissions] = organizationIds.length === 0 ? [[], []] : await Promise.all([
    prisma.clubRosterMember.findMany({
      where: { organizationId: { in: organizationIds }, clubYear: { in: years }, personId: { in: personIds } },
      select: { id: true, organizationId: true, personId: true },
    }),
    prisma.clubFormSubmission.findMany({
      where: {
        organizationId: { in: organizationIds },
        clubYear: { in: years },
        status: "SUBMITTED",
        template: { key: { in: [...HEALTH_FORM_KEYS] } },
      },
      orderBy: { submittedAt: "asc" },
      select: {
        id: true,
        organizationId: true,
        rosterMemberId: true,
        answers: true,
        sealedSensitiveAnswers: true,
        submittedAt: true,
        template: { select: { key: true, name: true } },
      },
    }),
  ]);

  const opened = new Map<string, Record<string, unknown>>();
  function answersFor(submission: (typeof submissions)[number]) {
    const cached = opened.get(submission.id);
    if (cached) return cached;
    const merged: Record<string, unknown> = pickHealthAnswers(submission.answers as Record<string, unknown>);
    if (submission.sealedSensitiveAnswers) {
      if (!isSecretEncryptionConfigured()) {
        throw new HealthViewError("ENCRYPTION_UNAVAILABLE", "Encryption isn't set up on this server, so emergency contacts can't be read.");
      }
      try {
        // Every key this view does not use is dropped here, before anything else can touch it.
        Object.assign(merged, pickHealthAnswers(openSensitiveAnswers(submission.id, submission.sealedSensitiveAnswers)));
      } catch (error) {
        if (error instanceof SecretBoxError) throw new HealthViewError("SENSITIVE_UNREADABLE", "Emergency contacts can't be read on this server.");
        throw error;
      }
    }
    opened.set(submission.id, merged);
    return merged;
  }

  // Every roster member row for a person, across both club years when the event spans two.
  const membersByPerson = new Map<string, Set<string>>();
  for (const member of rosterMembers) {
    const key = `${member.organizationId}:${member.personId}`;
    membersByPerson.set(key, (membersByPerson.get(key) ?? new Set()).add(member.id));
  }
  const dates = eventCalendarDates(event);
  const clubs: HealthClubSheet[] = registrations.map((row) => {
    const organizationId = row.organization.id;
    const clubSubmissions = submissions.filter((submission) => submission.organizationId === organizationId);
    const clubHasPassengerLists = clubSubmissions.some((submission) => submission.template.key === PASSENGER_LIST_KEY);
    const nameCounts = new Map<string, number>();
    for (const attendee of row.registration.attendees) {
      const key = normalizeName(attendee.person.firstName, attendee.person.lastName);
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    const rows: HealthAttendeeRow[] = row.registration.attendees.map((attendee) => {
      const name = `${attendee.person.firstName} ${attendee.person.lastName}`.replace(/\s+/g, " ").trim();
      const rosterMemberIds = membersByPerson.get(`${organizationId}:${attendee.personId}`) ?? new Set<string>();
      const wanted = normalizeName(attendee.person.firstName, attendee.person.lastName);
      const nameIsShared = (nameCounts.get(wanted) ?? 0) > 1;
      const contacts: EmergencyContact[] = [];
      let withheldForSharedName = false;
      for (const submission of clubSubmissions) {
        if (submission.template.key === PERMISSION_SLIP_KEY && submission.rosterMemberId && rosterMemberIds.has(submission.rosterMemberId)) {
          const answers = answersFor(submission);
          const contact = slipContact({
            rosterMemberId: submission.rosterMemberId,
            formName: submission.template.name,
            submittedAt: submission.submittedAt,
            emergencyPhone: answers[SLIP_EMERGENCY_KEY],
            activityDate: answers[ACTIVITY_DATE_KEY],
            event: dates,
          });
          if (contact) contacts.push(contact);
        }
        if (submission.template.key === PASSENGER_LIST_KEY) {
          const answers = answersFor(submission);
          const matches = passengerContacts({
            formName: submission.template.name,
            submittedAt: submission.submittedAt,
            passengers: Array.from({ length: PASSENGER_SLOTS }, (_, index) => ({
              name: answers[passengerNameKey(index + 1)],
              emergencyContact: answers[passengerEmergencyKey(index + 1)],
            })),
          });
          for (const match of matches) {
            if (normalizeName(match.name, "") !== wanted) continue;
            // Two attendees share this name: a contact could belong to either, so it is withheld.
            if (nameIsShared) withheldForSharedName = true;
            else contacts.push(match.contact);
          }
        }
      }
      const emergencyStatus: EmergencyStatus = withheldForSharedName ? "AMBIGUOUS_NAME"
        : contacts.length === 0 && clubHasPassengerLists ? "NO_CONTACT_MATCHED"
          : "NONE_ON_FILE";
      return {
        attendeeId: attendee.id,
        name,
        dietary: dietaryFromResponses(attendee.formResponses),
        medicalFlag: medicalFlagFromResponses(attendee.formResponses),
        emergencyContacts: sortContacts(contacts),
        emergencyStatus,
      };
    });
    // One sheet per registration: a club's teams (#809) each get their own, named "Team (Club)".
    return { organizationId, ...(row.teamKey ? { teamKey: row.teamKey } : {}), clubName: teamLabel(row.organization.name, row.teamName), attendees: sortAttendees(rows) };
  });

  return {
    event: {
      id: event.id,
      name: event.name,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      availableThrough: healthWindowEndsOn(event),
    },
    purpose,
    clubs,
  };
}
