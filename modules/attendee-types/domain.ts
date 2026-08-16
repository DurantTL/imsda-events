import { z } from "zod";

export const attendeeClassificationKinds = ["CATEGORY", "TRACK", "DEPARTMENT"] as const;
const codeSchema = z.string().trim().min(2).max(40).transform((value) => value.toUpperCase()).pipe(
  z.string().regex(/^[A-Z][A-Z0-9_]*$/, "Codes use uppercase letters, numbers, and underscores."),
);

const ageBandInvariant = (
  value: { minimumAge: number | null; maximumAge: number | null },
  context: z.RefinementCtx,
) => {
  if (value.minimumAge !== null && value.maximumAge !== null && value.minimumAge > value.maximumAge) {
    context.addIssue({ code: "custom", path: ["minimumAge"], message: "Minimum age cannot exceed maximum age." });
  }
};

const attendeeTypeBaseSchema = z.object({
  code: codeSchema,
  label: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(""),
  sortOrder: z.number().int().min(-10000).max(10000).default(0),
  isActive: z.boolean().default(true),
  minimumAge: z.number().int().min(0).max(130).nullable().default(null),
  maximumAge: z.number().int().min(0).max(130).nullable().default(null),
});

export const attendeeTypeInputSchema = attendeeTypeBaseSchema.superRefine(ageBandInvariant);

export const attendeeTypeUpdateSchema = attendeeTypeBaseSchema.omit({ code: true }).superRefine(ageBandInvariant);

export const attendeeClassificationInputSchema = z.object({
  kind: z.enum(attendeeClassificationKinds),
  code: codeSchema,
  label: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(""),
  sortOrder: z.number().int().min(-10000).max(10000).default(0),
  isActive: z.boolean().default(true),
});

export const attendeeClassificationUpdateSchema = attendeeClassificationInputSchema.omit({ kind: true, code: true });

export type AttendeeTypeOption = {
  id: string;
  code: string;
  label: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
  minimumAge: number | null;
  maximumAge: number | null;
};

export type AttendeeTypeReference = {
  id: string | null;
  code: string | null;
  labelSnapshot: string;
  ageBand: { minimumAge: number | null; maximumAge: number | null } | null;
};

/** Stable consumer contract: identity and age band come from configuration;
 * labelSnapshot always comes from the historical registration row. */
export function attendeeTypeReference(attendee: {
  attendeeType: string;
  attendeeTypeDefinition: null | { id: string; code: string; minimumAge: number | null; maximumAge: number | null };
}): AttendeeTypeReference {
  const definition = attendee.attendeeTypeDefinition;
  return {
    id: definition?.id ?? null,
    code: definition?.code ?? null,
    labelSnapshot: attendee.attendeeType,
    ageBand: definition ? { minimumAge: definition.minimumAge, maximumAge: definition.maximumAge } : null,
  };
}

export function ageOnEventDate(dateOfBirth: Date, eventDate: Date): number {
  let age = eventDate.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const beforeBirthday = eventDate.getUTCMonth() < dateOfBirth.getUTCMonth()
    || (eventDate.getUTCMonth() === dateOfBirth.getUTCMonth() && eventDate.getUTCDate() < dateOfBirth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function isWithinAgeBand(
  dateOfBirth: Date,
  eventDate: Date,
  ageBand: { minimumAge: number | null; maximumAge: number | null },
) {
  const age = ageOnEventDate(dateOfBirth, eventDate);
  return (ageBand.minimumAge === null || age >= ageBand.minimumAge)
    && (ageBand.maximumAge === null || age <= ageBand.maximumAge);
}

function normalizedLegacyValue(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

export type AttendeeTypeBackfillRow = {
  value: string;
  count: number;
  status: "MAPPABLE" | "UNMAPPABLE" | "AMBIGUOUS";
  attendeeTypeId: string | null;
  attendeeTypeCode: string | null;
};

/** Exact normalized code/label matches only. Multiple exact candidates are
 * reported as ambiguous; the planner never makes a heuristic choice. */
export function planAttendeeTypeBackfill(
  types: Array<Pick<AttendeeTypeOption, "id" | "code" | "label">>,
  values: Array<{ attendeeType: string; count: number }>,
): AttendeeTypeBackfillRow[] {
  return values.map(({ attendeeType: value, count }) => {
    const normalized = normalizedLegacyValue(value);
    const matches = types.filter((type) => (
      normalizedLegacyValue(type.code) === normalized || normalizedLegacyValue(type.label) === normalized
    ));
    return {
      value,
      count,
      status: matches.length === 1 ? "MAPPABLE" : matches.length === 0 ? "UNMAPPABLE" : "AMBIGUOUS",
      attendeeTypeId: matches.length === 1 ? matches[0]!.id : null,
      attendeeTypeCode: matches.length === 1 ? matches[0]!.code : null,
    };
  });
}
