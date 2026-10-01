import {
  registrationFormDefinitionSchema,
  type RegistrationFormDefinition,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import { withAttendeeTypeOptionsForAttendee } from "@/modules/attendee-types/form-options";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import { buildOperationalReport } from "@/modules/reporting/operational-reports";
import {
  shirtSizeConfirmedAtFromResponses,
  shirtSizeFromResponses,
} from "@/modules/registrations/shirt-sizes";

export const badgeTemplateIds = [
  "avery-5395",
  "avery-5392",
  "avery-presta-94237",
] as const;

export type BadgeTemplateId = typeof badgeTemplateIds[number];

export const badgeOrientations = ["portrait", "landscape"] as const;
export type BadgeOrientation = typeof badgeOrientations[number];

export const badgeTemplates: Record<BadgeTemplateId, {
  id: BadgeTemplateId;
  product: string;
  label: string;
  dimensions: string;
  perSheet: number;
  /** Printed slot size on the physical sheet, in inches, as laid out today. */
  slotWidthIn: number;
  slotHeightIn: number;
}> = {
  "avery-5395": {
    id: "avery-5395",
    product: "Avery 5395",
    label: "Adhesive name badges",
    dimensions: "2⅓ × 3⅜ inches",
    perSheet: 8,
    slotWidthIn: 3.375,
    slotHeightIn: 2.333333,
  },
  "avery-5392": {
    id: "avery-5392",
    product: "Avery 5392",
    label: "Name badge inserts",
    dimensions: "3 × 4 inches",
    perSheet: 6,
    slotWidthIn: 4,
    slotHeightIn: 3,
  },
  "avery-presta-94237": {
    id: "avery-presta-94237",
    product: "Avery Presta 94237",
    label: "Rectangle labels",
    dimensions: "2 × 3 inches",
    perSheet: 8,
    slotWidthIn: 3,
    slotHeightIn: 2,
  },
};

/**
 * The printed page for every badge template. Avery sheets feed through the
 * printer upright (8.5 x 11 in), so the paper is always portrait letter; the
 * "orientation" option only turns the text inside each die-cut label. Zero
 * page margin: the template's own margins are the sheet's padding, so the grid
 * never depends on the browser's margin setting.
 */
export const badgePrintPageRule = "@page { size: letter portrait; margin: 0; }";

export function normalizeBadgeOrientation(value: string | undefined): BadgeOrientation {
  return badgeOrientations.includes(value as BadgeOrientation)
    ? value as BadgeOrientation
    : "portrait";
}

export type BadgeLabel = {
  attendeeId: string;
  attendeeType: string;
  /** What prints on the optional attendee-type line. */
  attendeeTypeLabel: string;
  confirmationCode: string;
  firstName: string;
  lastName: string;
  groupLabel: string;
  shirtSize: string | null;
  shirtSizeConfirmed: boolean;
};

export const badgeTextSizes = [80, 90, 100, 115, 130] as const;
export type BadgeTextSize = typeof badgeTextSizes[number];

/** Text size percentage for the whole layout; unknown values print at 100. */
export function normalizeBadgeTextSize(value: string | undefined): BadgeTextSize {
  const size = Number(value);
  return badgeTextSizes.includes(size as BadgeTextSize)
    ? size as BadgeTextSize
    : 100;
}

/** The event title prints unless the query explicitly sends `title=0`. */
export function normalizeBadgeShowTitle(value: string | string[] | undefined) {
  // The form sends a hidden title=0 followed by the checkbox's title=1, so an
  // unchecked box leaves only "0" and a checked one ends with "1".
  const last = Array.isArray(value) ? value[value.length - 1] : value;
  return last !== "0";
}

/** The attendee-type line prints unless the query explicitly sends `type=0`. */
export function normalizeBadgeShowAttendeeType(value: string | string[] | undefined) {
  const last = Array.isArray(value) ? value[value.length - 1] : value;
  return last !== "0";
}

function titleCase(value: string) {
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/(^|\s|-)([a-z])/g, (_, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`);
}

/**
 * The attendee-type line: the label of the attendee's own answer to the
 * form's explicit `attendee_type` SELECT/RADIO question at ATTENDEE scope;
 * otherwise the event's configured type label; otherwise the system label.
 */
function attendeeTypeLabelFor(
  registration: RegistrationRecord,
  attendee: RegistrationRecord["attendees"][number],
  definition: RegistrationFormDefinition | null,
) {
  const options = registration.publicSubmission?.attendeeTypeOptions ?? [];
  const answer = attendee.responses?.attendee_type;
  const raw = typeof answer === "string" ? answer.trim() : "";
  if (raw && definition) {
    const hydrated = withAttendeeTypeOptionsForAttendee(definition, options, raw);
    const field: RegistrationFormField | undefined = hydrated.sections
      .flatMap((section) => section.fields)
      .find((candidate) => (
        candidate.key === "attendee_type"
        && candidate.scope === "ATTENDEE"
        && (candidate.type === "SELECT" || candidate.type === "RADIO")
      ));
    // Only a real choice prints; an unknown stored value never reaches a badge.
    if (field?.options.includes(raw)) {
      const label = (field.optionLabels?.[raw] ?? raw).trim();
      if (label) return label;
    }
  }
  const configured = options
    .find((type) => type.code === attendee.attendeeTypeDefinitionCode)?.label;
  return configured?.trim() || titleCase(attendee.attendeeType);
}

export function normalizeBadgeTemplate(value: string | undefined) {
  // Avery 5163 was retired in favor of Presta 94237; keep old links working.
  if (value === "avery-5163") return "avery-presta-94237";
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
    .flatMap((registration) => {
      // Each registration carries its own form version; parse it once.
      const parsed = registrationFormDefinitionSchema.safeParse(
        registration.publicSubmission?.definition,
      );
      const definition = parsed.success ? parsed.data : null;
      return registration.attendees.map((attendee) => ({
        attendeeId: attendee.id,
        attendeeType: attendee.attendeeType,
        attendeeTypeLabel: attendeeTypeLabelFor(registration, attendee, definition),
        confirmationCode: registration.confirmationCode,
        firstName: attendee.firstName,
        lastName: attendee.lastName,
        groupLabel: groupByAttendee.get(attendee.id)
          ?? "Individual / ungrouped registration",
        shirtSize: shirtSizeFromResponses(attendee.responses),
        shirtSizeConfirmed: Boolean(
          shirtSizeConfirmedAtFromResponses(attendee.responses),
        ),
      }));
    })
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
