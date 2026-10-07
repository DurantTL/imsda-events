import "server-only";

import type { RegistrationStatus } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  clubAssignmentStatus,
  type ClubAssignmentFields,
} from "@/modules/club-registrations/assignments";
import { listClubAssignments } from "@/modules/club-registrations/assignments-repository";
import { churchOwedCents, type ClubRegistrationStatus } from "@/modules/club-registrations/church-owed";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import { teamLabel } from "@/modules/club-teams/domain";
import {
  assignmentKey,
  buildCampingReport,
  buildClubEventRecord,
  buildDutiesActivitiesReport,
  buildSpecialRolesReport,
  buildSpiritualMilestonesReport,
  type ClubAssignmentSummary,
  type ClubEventRecord,
} from "@/modules/reporting/club-event-reports";
import { listRegistrations, type RegistrationRecord } from "@/modules/registrations/repository";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The Spring Camporee form's late-pricing label for the attendee fee field, or null if it has none configured. */
function lateRateLabelFromRegistration(registration: RegistrationRecord | undefined): string | null {
  const definition = record(registration?.publicSubmission?.definition);
  const sections = Array.isArray(definition.sections) ? definition.sections : [];
  for (const section of sections) {
    const fields = Array.isArray(record(section).fields) ? (record(section).fields as unknown[]) : [];
    for (const field of fields) {
      const candidate = record(field);
      if (candidate.key === "registration_fee") {
        const latePricing = record(candidate.latePricing);
        return typeof latePricing.label === "string" ? latePricing.label : null;
      }
    }
  }
  return null;
}

/** The form's late-pricing start date for the attendee fee field, or null. */
function earlyBirdDeadlineFromRegistration(registration: RegistrationRecord | undefined): string | null {
  const definition = record(registration?.publicSubmission?.definition);
  const sections = Array.isArray(definition.sections) ? definition.sections : [];
  for (const section of sections) {
    const fields = Array.isArray(record(section).fields) ? (record(section).fields as unknown[]) : [];
    for (const field of fields) {
      const candidate = record(field);
      if (candidate.key === "registration_fee") {
        const latePricing = record(candidate.latePricing);
        return typeof latePricing.startsOn === "string" ? latePricing.startsOn : null;
      }
    }
  }
  return null;
}

function toClubAssignmentSummary(fields: ClubAssignmentFields): ClubAssignmentSummary {
  return clubAssignmentStatus(fields) === "UNASSIGNED" ? null : fields;
}

/**
 * Every active (submitted/confirmed) club registration for a club event,
 * built into the reports' shared `ClubEventRecord` shape, plus each club's
 * campsite/duty/activity assignment (#410). By default waitlisted and cancelled club
 * registrations are excluded — they owe nothing and never appear here.
 */
export async function getClubEventRecords(
  eventId: string,
  options: { locationId?: string | null; statuses?: readonly RegistrationStatus[] } = {},
): Promise<{
  clubs: ClubEventRecord[];
  assignments: Map<string, ClubAssignmentSummary>;
  earlyBirdDeadline: string | null;
  /** The registrations the clubs were built from, for callers that need raw attendee answers. */
  registrations: RegistrationRecord[];
}> {
  const statuses = options.statuses ?? activeRegistrationStatuses;
  const [clubRegistrations, registrations, assignmentRows] = await Promise.all([
    getPrisma().clubEventRegistration.findMany({
      where: {
        eventId,
        registration: {
          status: { in: [...statuses] },
          ...(options.locationId ? { locationId: options.locationId } : {}),
        },
      },
      select: {
        organizationId: true,
        registrationId: true,
        teamKey: true,
        teamName: true,
        organization: { select: { name: true, parentOrganization: { select: { name: true } } } },
      },
    }),
    listRegistrations(eventId, { statuses, locationId: options.locationId }),
    listClubAssignments(eventId),
  ]);

  const registrationsById = new Map(registrations.map((registration) => [registration.id, registration]));
  const assignments = new Map<string, ClubAssignmentSummary>(
    assignmentRows.map((row) => [assignmentKey(row.organizationId, row.teamKey), toClubAssignmentSummary(row.fields)]),
  );

  let earlyBirdDeadline: string | null = null;
  const clubs: ClubEventRecord[] = [];
  for (const row of clubRegistrations) {
    const registration = registrationsById.get(row.registrationId);
    if (!registration) continue;
    if (!earlyBirdDeadline) earlyBirdDeadline = earlyBirdDeadlineFromRegistration(registration);
    clubs.push(buildClubEventRecord({
      organizationId: row.organizationId,
      organizationName: teamLabel(row.organization.name, row.teamName),
      teamKey: row.teamKey,
      teamName: row.teamName,
      sponsoringChurch: row.organization.parentOrganization?.name ?? null,
      registrationId: registration.id,
      confirmationCode: registration.confirmationCode,
      status: registration.status,
      submittedAt: registration.submittedAt,
      registrationResponses: registration.publicSubmission?.responses ?? {},
      attendees: registration.attendees.map((attendee) => ({
        id: attendee.id,
        firstName: attendee.firstName,
        lastName: attendee.lastName,
        responses: attendee.responses,
      })),
      amountOwedCents: churchOwedCents(registration.status as ClubRegistrationStatus, registration.totalAmountCents),
      pricingSnapshot: registration.publicSubmission?.pricingSnapshot ?? {},
      lateRateLabel: lateRateLabelFromRegistration(registration),
      locationId: registration.location?.id ?? null,
      locationName: registration.location?.name ?? null,
    }));
  }

  return { clubs, assignments, earlyBirdDeadline, registrations };
}

export async function getClubEventReports(eventId: string, options: { locationId?: string | null } = {}) {
  const { clubs, assignments } = await getClubEventRecords(eventId, options);
  return {
    camping: buildCampingReport(clubs),
    dutiesActivities: buildDutiesActivitiesReport(clubs, assignments),
    milestones: buildSpiritualMilestonesReport(clubs),
    specialRoles: buildSpecialRolesReport(clubs),
    clubCount: clubs.length,
  };
}
