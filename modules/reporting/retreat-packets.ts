import type { RegistrationRecord } from "@/modules/registrations/repository";
import { shirtSizeFromResponses } from "@/modules/registrations/shirt-sizes";
import {
  buildOperationalReport,
  type OperationalRosterGroup,
} from "@/modules/reporting/operational-reports";

export type RetreatPacketAssignment = {
  fieldLabel: string;
  attendeeId: string;
  option: string | null;
};

export type RetreatPacketGroup = {
  id: string;
  label: string;
  fieldLabel: string | null;
  registrations: Array<{
    id: string;
    confirmationCode: string;
    accountHolderName: string;
    email: string;
    phone: string;
    attendeeCount: number;
    checkedInCount: number;
  }>;
  attendees: Array<{
    id: string;
    firstName: string;
    lastName: string;
    attendeeType: string;
    confirmationCode: string;
    shirtSize: string | null;
    checkedIn: boolean;
    assignments: Array<{ label: string; option: string }>;
  }>;
  mealCounts: Array<{ label: string; values: string[] }>;
  housingCounts: Array<{ label: string; values: string[] }>;
};

function countLines(fields: ReturnType<typeof buildOperationalReport>["meals"]) {
  return fields.map((field) => ({
    label: field.label,
    values: field.counts
      .filter((row) => row.count > 0)
      .map((row) => `${row.label}: ${row.count}`),
  })).filter((field) => field.values.length > 0);
}

export function buildRetreatPacketGroups(
  registrations: RegistrationRecord[],
  rosterGroups: OperationalRosterGroup[],
  assignments: RetreatPacketAssignment[],
): RetreatPacketGroup[] {
  const registrationsById = new Map(
    registrations.map((registration) => [registration.id, registration]),
  );
  const assignmentMap = new Map<string, Array<{ label: string; option: string }>>();
  for (const assignment of assignments) {
    if (!assignment.option) continue;
    const current = assignmentMap.get(assignment.attendeeId) ?? [];
    current.push({ label: assignment.fieldLabel, option: assignment.option });
    assignmentMap.set(assignment.attendeeId, current);
  }

  return rosterGroups.map((group) => {
    const registrationIds = [...new Set(group.attendees.map((row) => row.registrationId))];
    const groupRegistrations = registrationIds
      .map((id) => registrationsById.get(id))
      .filter((registration): registration is RegistrationRecord => Boolean(registration));
    const groupReport = buildOperationalReport(groupRegistrations);
    const attendeesById = new Map(
      groupRegistrations.flatMap((registration) => (
        registration.attendees.map((attendee) => [
          attendee.id,
          { attendee, registration },
        ] as const)
      )),
    );

    return {
      id: group.id,
      label: group.label,
      fieldLabel: group.fieldLabel,
      registrations: groupRegistrations
        .map((registration) => ({
          id: registration.id,
          confirmationCode: registration.confirmationCode,
          accountHolderName: `${registration.accountHolder.firstName} ${registration.accountHolder.lastName}`.trim(),
          email: registration.accountHolder.email,
          phone: registration.accountHolder.phone,
          attendeeCount: registration.attendeeCount,
          checkedInCount: registration.checkedInCount,
        }))
        .sort((left, right) => (
          left.accountHolderName.localeCompare(right.accountHolderName)
          || left.confirmationCode.localeCompare(right.confirmationCode)
        )),
      attendees: group.attendees.map((row) => {
        const source = attendeesById.get(row.attendeeId);
        return {
          id: row.attendeeId,
          firstName: row.firstName,
          lastName: row.lastName,
          attendeeType: row.attendeeType,
          confirmationCode: row.confirmationCode,
          shirtSize: source ? shirtSizeFromResponses(source.attendee.responses) : null,
          checkedIn: source?.attendee.checkedIn ?? false,
          assignments: assignmentMap.get(row.attendeeId) ?? [],
        };
      }),
      mealCounts: countLines(groupReport.meals),
      housingCounts: countLines(groupReport.housing),
    };
  });
}
