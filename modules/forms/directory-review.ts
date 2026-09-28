import "server-only";

import { getPrisma } from "@/lib/prisma";
import {
  DIRECTORY_NOT_LISTED_VALUE,
  isDirectoryOptionSource,
  registrationFormDefinitionSchema,
  type DirectoryOptionSource,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";

/**
 * Staff review list for "Not listed" directory answers (#482): a director
 * couldn't find their club or church in the live directory, so they picked
 * "Not listed" and typed the name instead. Nothing here blocks registration;
 * it only surfaces the free text for staff to reconcile — add the missing
 * organization, or fix a typo the director actually meant to match.
 */
export type DirectoryReviewEntry = {
  registrationId: string;
  confirmationCode: string;
  source: DirectoryOptionSource;
  fieldLabel: string;
  freeText: string;
};

function recordFromJson(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type DirectoryField = { key: string; label: string; source: DirectoryOptionSource; companionKey: string | null };

function directoryFields(definition: RegistrationFormDefinition): DirectoryField[] {
  const allFields = definition.sections.flatMap((section) => section.fields);
  return allFields
    .filter((field) => isDirectoryOptionSource(field.optionSource))
    .map((field) => ({
      key: field.key,
      label: field.label,
      source: field.optionSource as DirectoryOptionSource,
      companionKey: allFields.find((candidate) => (
        candidate.conditional?.fieldKey === field.key && candidate.conditional.value === DIRECTORY_NOT_LISTED_VALUE
      ))?.key ?? null,
    }));
}

/** Every "Not listed" club or church answer on an active (SUBMITTED or
 * CONFIRMED) registration for this event, across every form and version it
 * has ever used. Reads each registration's current answers: the latest
 * amendment's snapshot when there is one, else the original submission — so
 * an entry staff have since corrected to a real club drops off the list. */
export async function listDirectoryReviewEntries(eventId: string): Promise<DirectoryReviewEntry[]> {
  const forms = await getPrisma().registrationForm.findMany({
    where: { eventId },
    select: { versions: { select: { id: true, definition: true } } },
  });
  const fieldsByVersionId = new Map<string, DirectoryField[]>();
  for (const form of forms) {
    for (const version of form.versions) {
      const parsed = registrationFormDefinitionSchema.safeParse(version.definition);
      if (!parsed.success) continue;
      const fields = directoryFields(parsed.data);
      if (fields.length > 0) fieldsByVersionId.set(version.id, fields);
    }
  }
  if (fieldsByVersionId.size === 0) return [];

  const submissions = await getPrisma().publicRegistrationSubmission.findMany({
    where: {
      formVersionId: { in: [...fieldsByVersionId.keys()] },
      registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
    },
    select: {
      formVersionId: true,
      responses: true,
      registration: {
        select: {
          id: true,
          confirmationCode: true,
          operations: {
            where: { type: "AMENDMENT" },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { afterSnapshot: true },
          },
        },
      },
    },
  });

  const entries: DirectoryReviewEntry[] = [];
  for (const submission of submissions) {
    const fields = fieldsByVersionId.get(submission.formVersionId);
    if (!fields) continue;
    const amended = recordFromJson(recordFromJson(submission.registration.operations?.[0]?.afterSnapshot).registrationResponses);
    const responses = Object.keys(amended).length > 0 ? amended : recordFromJson(submission.responses);
    for (const field of fields) {
      if (responses[field.key] !== DIRECTORY_NOT_LISTED_VALUE) continue;
      const freeText = field.companionKey && typeof responses[field.companionKey] === "string"
        ? (responses[field.companionKey] as string).trim()
        : "";
      entries.push({
        registrationId: submission.registration.id,
        confirmationCode: submission.registration.confirmationCode,
        source: field.source,
        fieldLabel: field.label,
        freeText,
      });
    }
  }
  return entries.sort((left, right) => left.confirmationCode.localeCompare(right.confirmationCode));
}
