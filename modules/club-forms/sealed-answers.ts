import "server-only";

import { openSecret, sealSecret } from "@/lib/secret-box";

/**
 * The only place a club form's sensitive answers are sealed or opened
 * (#610), the same way `modules/club-rosters/birth-dates.ts` seals birth
 * dates. The key purpose includes the submission's own id, so a sealed value
 * copied to another row cannot be opened there.
 */
function purposeFor(submissionId: string) {
  return `club-form:sensitive-answers:${submissionId}`;
}

export function sealSensitiveAnswers(submissionId: string, answers: Record<string, unknown>) {
  return sealSecret(JSON.stringify(answers), purposeFor(submissionId));
}

export function openSensitiveAnswers(submissionId: string, sealed: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(openSecret(sealed, purposeFor(submissionId)));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}
