import type { RegistrationRecord } from "@/modules/registrations/repository";
import { buildOperationalReport } from "@/modules/reporting/operational-reports";
import {
  shirtSizeConfirmedAtFromResponses,
  shirtSizeFromResponses,
} from "@/modules/registrations/shirt-sizes";

export const badgeTemplateIds = [
  "avery-5395",
  "avery-5392",
  "avery-5163",
] as const;

export type BadgeTemplateId = typeof badgeTemplateIds[number];

export const badgeTemplates: Record<BadgeTemplateId, {
  id: BadgeTemplateId;
  product: string;
  label: string;
  dimensions: string;
  perSheet: number;
}> = {
  "avery-5395": {
    id: "avery-5395",
    product: "Avery 5395",
    label: "Adhesive name badges",
    dimensions: "2⅓ × 3⅜ inches",
    perSheet: 8,
  },
  "avery-5392": {
    id: "avery-5392",
    product: "Avery 5392",
    label: "Name badge inserts",
    dimensions: "3 × 4 inches",
    perSheet: 6,
  },
  "avery-5163": {
    id: "avery-5163",
    product: "Avery 5163",
    label: "Adhesive labels",
    dimensions: "2 × 4 inches",
    perSheet: 10,
  },
};

export type BadgeLabel = {
  attendeeId: string;
  attendeeType: string;
  confirmationCode: string;
  firstName: string;
  lastName: string;
  groupLabel: string;
  shirtSize: string | null;
  shirtSizeConfirmed: boolean;
};

export function normalizeBadgeTemplate(value: string | undefined) {
  return badgeTemplateIds.includes(value as BadgeTemplateId)
    ? value as BadgeTemplateId
    : "avery-5395";
}

export function normalizeBadgeStartingPosition(
  value: string | undefined,
  perSheet: number,
) {
  const position = Number(value);
  return Number.isInteger(position) && position >= 1 && position <= perSheet
    ? position
    : 1;
}

export function buildBadgeLabels(
  registrations: RegistrationRecord[],
): BadgeLabel[] {
  const report = buildOperationalReport(registrations);
  const groupByAttendee = new Map(
    report.rosterGroups.flatMap((group) => (
      group.attendees.map((attendee) => [attendee.attendeeId, group.label] as const)
    )),
  );

  return registrations
    .flatMap((registration) => (
      registration.attendees.map((attendee) => ({
        attendeeId: attendee.id,
        attendeeType: attendee.attendeeType,
        confirmationCode: registration.confirmationCode,
        firstName: attendee.firstName,
        lastName: attendee.lastName,
        groupLabel: groupByAttendee.get(attendee.id)
          ?? "Individual / ungrouped registration",
        shirtSize: shirtSizeFromResponses(attendee.responses),
        shirtSizeConfirmed: Boolean(
          shirtSizeConfirmedAtFromResponses(attendee.responses),
        ),
      }))
    ))
    .sort((left, right) => (
      left.lastName.localeCompare(right.lastName)
      || left.firstName.localeCompare(right.firstName)
      || left.confirmationCode.localeCompare(right.confirmationCode)
    ));
}

export function paginateBadgeLabels(
  labels: BadgeLabel[],
  templateId: BadgeTemplateId,
  startingPosition = 1,
) {
  const perSheet = badgeTemplates[templateId].perSheet;
  const normalizedStart = normalizeBadgeStartingPosition(
    String(startingPosition),
    perSheet,
  );
  const slots: Array<BadgeLabel | null> = [
    ...Array.from<null>({ length: normalizedStart - 1 }).fill(null),
    ...labels,
  ];
  const sheets: Array<Array<BadgeLabel | null>> = [];
  for (let index = 0; index < slots.length; index += perSheet) {
    sheets.push([
      ...slots.slice(index, index + perSheet),
      ...Array.from<null>({
        length: Math.max(0, perSheet - slots.slice(index, index + perSheet).length),
      }).fill(null),
    ]);
  }
  return sheets;
}
