import { createHash } from "node:crypto";
import { z } from "zod";
import { isWithinAgeBand } from "@/modules/attendee-types/domain";

export const policyKinds = ["CONSENT", "WAIVER", "ACKNOWLEDGMENT", "APPROVAL_REQUIRED"] as const;
export type PolicyKind = (typeof policyKinds)[number];

export const policyScopes = ["EVENT", "ORGANIZATION"] as const;
export type PolicyScope = (typeof policyScopes)[number];

export const policyVersionStatuses = ["DRAFT", "PUBLISHED"] as const;
export type PolicyVersionStatus = (typeof policyVersionStatuses)[number];

export class PolicyKindMismatchError extends Error {
  constructor(public readonly expected: PolicyKind, public readonly actual: PolicyKind) {
    super(`Expected a ${expected} policy but received a ${actual} policy.`);
    this.name = "PolicyKindMismatchError";
  }
}

/**
 * Consent, waiver, acknowledgment, and discretionary approval are never
 * interchangeable. Consumers that record evidence for one kind narrow the
 * policy through this guard so a waiver can never satisfy a consent
 * requirement (or vice versa), even when both are applicable to the same
 * attendee.
 */
export function requirePolicyKind<K extends PolicyKind, T extends { kind: PolicyKind }>(
  policy: T,
  expected: K,
): T & { kind: K } {
  if (policy.kind !== expected) throw new PolicyKindMismatchError(expected, policy.kind);
  return policy as T & { kind: K };
}

const slugSchema = z.string().trim().min(2).max(60).transform((value) => value.toLowerCase()).pipe(
  z.string().regex(/^[a-z][a-z0-9-]*$/, "Slugs use lowercase letters, numbers, and hyphens."),
);

/**
 * `scope` and `eventId` must agree: an EVENT-scoped policy always belongs to
 * one event, and an ORGANIZATION-scoped policy never does. The migration
 * enforces the same rule with a check constraint.
 */
export const consentPolicyInputSchema = z.object({
  kind: z.enum(policyKinds),
  scope: z.enum(policyScopes),
  eventId: z.string().min(1).nullable(),
  slug: slugSchema,
  name: z.string().trim().min(2).max(120),
}).superRefine((value, context) => {
  if (value.scope === "EVENT" && value.eventId === null) {
    context.addIssue({ code: "custom", path: ["eventId"], message: "Event-scoped policies must belong to an event." });
  }
  if (value.scope === "ORGANIZATION" && value.eventId !== null) {
    context.addIssue({ code: "custom", path: ["eventId"], message: "Organization-scoped policies cannot belong to a single event." });
  }
});

/** No structural validation of the text itself — policy text is staff-entered
 * data, never authored or judged by this codebase. */
export const consentPolicyVersionContentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  bodyText: z.string().trim().min(1).max(100_000),
});
export type ConsentPolicyVersionContent = z.infer<typeof consentPolicyVersionContentSchema>;

export const consentPolicyPublishInputSchema = z.object({
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().nullable().default(null),
  /** Whether this version materially changes obligations is a human judgment
   * made at publish time, not something inferred by diffing text. It is
   * explicitly recorded for every published version, including the first. */
  isMaterialChange: z.boolean(),
}).superRefine((value, context) => {
  if (value.effectiveTo !== null && value.effectiveTo.getTime() <= value.effectiveFrom.getTime()) {
    context.addIssue({ code: "custom", path: ["effectiveTo"], message: "Effective-to must be after effective-from." });
  }
});
export type ConsentPolicyPublishInput = z.input<typeof consentPolicyPublishInputSchema>;

/** Hash of exactly the text a person is shown. Title and body are encoded as a
 * JSON array so no pair of different contents can collide by concatenation. */
export function contentHashFor(content: ConsentPolicyVersionContent): string {
  return createHash("sha256").update(JSON.stringify([content.title, content.bodyText])).digest("hex");
}

export type PolicyVersionForSelection = {
  id: string;
  versionNumber: number;
  status: PolicyVersionStatus;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
};

/** Effective windows are half-open: `effectiveFrom <= at < effectiveTo`, so a
 * version ending at the instant its successor starts does not overlap it. A
 * null `effectiveTo` is open-ended. */
export function isEffectiveAt(version: PolicyVersionForSelection, atDate: Date) {
  return version.status === "PUBLISHED"
    && version.effectiveFrom !== null
    && version.effectiveFrom.getTime() <= atDate.getTime()
    && (version.effectiveTo === null || atDate.getTime() < version.effectiveTo.getTime());
}

/**
 * The version presented to a person at a point in time is whichever published
 * version's effective window contains that date — never "the latest
 * version". Drafts are never selectable. Overlapping windows (a correction
 * published with a start date before a prior version's end date, or a prior
 * version with no end) resolve to the higher version number, since a later
 * version number is always the more recent publication.
 */
export function selectEffectiveVersion<T extends PolicyVersionForSelection>(
  versions: T[],
  atDate: Date,
): T | null {
  return versions
    .filter((version) => isEffectiveAt(version, atDate))
    .reduce<T | null>((latest, candidate) => (
      latest === null || candidate.versionNumber > latest.versionNumber ? candidate : latest
    ), null);
}

function normalizedRole(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed.toLocaleLowerCase("en-US");
}

const applicabilityBaseSchema = z.object({
  attendeeTypeDefinitionId: z.string().min(1).nullable().default(null),
  role: z.string().max(80).nullable().default(null).transform(normalizedRole),
  minimumAge: z.number().int().min(0).max(130).nullable().default(null),
  maximumAge: z.number().int().min(0).max(130).nullable().default(null),
  isRequired: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

const applicabilityAgeBand = (
  value: { minimumAge: number | null; maximumAge: number | null },
  context: z.RefinementCtx,
) => {
  if (value.minimumAge !== null && value.maximumAge !== null && value.minimumAge > value.maximumAge) {
    context.addIssue({ code: "custom", path: ["minimumAge"], message: "Minimum age cannot exceed maximum age." });
  }
};

export const policyApplicabilityInputSchema = applicabilityBaseSchema
  .extend({ policyId: z.string().min(1) })
  .superRefine(applicabilityAgeBand);

/** The policy an applicability row points at is fixed; only who it applies to
 * and whether it is required can change. */
export const policyApplicabilityUpdateSchema = applicabilityBaseSchema.superRefine(applicabilityAgeBand);

export type ApplicabilityCondition = {
  attendeeTypeDefinitionId: string | null;
  role: string | null;
  minimumAge: number | null;
  maximumAge: number | null;
};

export type ApplicabilitySubject = {
  attendeeTypeDefinitionId: string | null;
  role: string | null;
  dateOfBirth: Date | null;
};

/** Every non-null condition on the applicability row must match the subject;
 * a null condition matches everyone for that dimension. An age-banded row
 * never matches a subject with no date of birth — the attendee's age is
 * unknown, so the caller must collect it rather than guess. Ages are
 * evaluated on the event date, as attendee-type age bands are. */
export function applicabilityMatches(
  condition: ApplicabilityCondition,
  subject: ApplicabilitySubject,
  eventDate: Date,
): boolean {
  if (condition.attendeeTypeDefinitionId !== null && condition.attendeeTypeDefinitionId !== subject.attendeeTypeDefinitionId) {
    return false;
  }
  if (condition.role !== null && normalizedRole(condition.role) !== normalizedRole(subject.role)) {
    return false;
  }
  if (condition.minimumAge !== null || condition.maximumAge !== null) {
    if (subject.dateOfBirth === null) return false;
    if (!isWithinAgeBand(subject.dateOfBirth, eventDate, { minimumAge: condition.minimumAge, maximumAge: condition.maximumAge })) {
      return false;
    }
  }
  return true;
}
