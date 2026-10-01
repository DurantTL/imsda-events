import { clubFormProblem } from "@/modules/club-registrations/domain";
import { registrationFormDefinitionSchema, type RegistrationFormDefinition } from "@/modules/forms/definition";

/**
 * The one form the club portal serves for an event (#720): the oldest
 * published form, by creation time and then id as a tiebreak. This is the only
 * place that rule lives; `publishedClubForm` (the portal) and the public event
 * page both call it, so a card can never promise a form the portal won't open.
 *
 * `definition` is the form's latest published definition, unparsed. Returns
 * null when there are no forms or the oldest one's definition is unreadable.
 * `problem` is why club registration can't use that form, or null when it can.
 */
export function pickClubPortalForm<T extends { id: string; createdAt: Date; definition: unknown }>(
  forms: readonly T[],
): { form: T; definition: RegistrationFormDefinition; problem: string | null } | null {
  const oldest = [...forms].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
  if (!oldest) return null;
  const parsed = registrationFormDefinitionSchema.safeParse(oldest.definition);
  if (!parsed.success) return null;
  return { form: oldest, definition: parsed.data, problem: clubFormProblem(parsed.data) };
}
