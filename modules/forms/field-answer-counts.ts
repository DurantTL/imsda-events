/**
 * Client-safe limit shared by the answer-count route and the registration
 * builder (#471): the route accepts at most this many field keys per
 * request, and the builder batches a larger removal (a whole section, say)
 * into requests of this size and merges the counts.
 */
export const FIELD_ANSWER_COUNT_BATCH_SIZE = 20;

export function batchFieldKeys(keys: readonly string[], size = FIELD_ANSWER_COUNT_BATCH_SIZE): string[][] {
  const unique = [...new Set(keys)];
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += size) batches.push(unique.slice(index, index + size));
  return batches;
}

/** Shown whenever the real counts couldn't be loaded: never a guess. */
export const NEUTRAL_REMOVAL_ANSWER_NOTE = "Answers already submitted stay on those registrations.";

/**
 * The "already submitted" sentence for the builder's removal dialog. Counts
 * are per registration (see `countFieldAnswers`), so a section's fields are
 * never summed — one registration answering three fields is still one
 * registration. The largest per-field count is a true lower bound on how
 * many registrations hold answers, so a section reports "at least" that.
 * `counts === null` means the lookup failed: say nothing about how many.
 */
export function removalAnswerNote(
  kind: "field" | "section",
  fieldKeys: readonly string[],
  counts: Readonly<Record<string, number>> | null,
): string {
  if (!counts || fieldKeys.some((key) => typeof counts[key] !== "number")) return NEUTRAL_REMOVAL_ANSWER_NOTE;
  const most = Math.max(0, ...fieldKeys.map((key) => counts[key]!));
  const registrations = `${most} registration${most === 1 ? "" : "s"}`;
  if (kind === "field") {
    return most > 0
      ? `${registrations} already ${most === 1 ? "has" : "have"} an answer for it. Those answers stay on those registrations.`
      : "No registration has an answer for it yet.";
  }
  return most > 0
    ? `At least ${registrations} already ${most === 1 ? "has" : "have"} answers for these fields. Those answers stay on those registrations.`
    : "No registration has an answer for these fields yet.";
}
