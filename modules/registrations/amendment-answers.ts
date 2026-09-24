import type { PublicRegistrationIssue } from "@/modules/forms/public-domain";

/**
 * Amendments to older registrations (WR26). Registrations imported from the
 * 2026 sheets, or filed under an earlier form version, can hold answers the
 * form doesn't configure (e.g. `attendee_email`) or answers today's rules
 * wouldn't accept (a Teen with no seminar ranks). Staff editing something
 * else shouldn't be blocked by answers nobody touched: unconfigured answers
 * are kept as they were, and only answers that changed are held to the rules.
 */

type Answers = Record<string, unknown>;

function isEmptyAnswer(value: unknown) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Answers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Whether two stored answers are the same; blank, null, and missing all count as unanswered. */
export function sameAnswer(left: unknown, right: unknown) {
  if (isEmptyAnswer(left) && isEmptyAnswer(right)) return true;
  return stableJson(left) === stableJson(right);
}

/**
 * Splits submitted answers into the ones the form configures (validated as
 * usual) and unconfigured ones sent back unchanged from `stored` (kept as
 * they were, never validated). An unconfigured answer that was added or
 * changed stays in `answers`, so validation still rejects it.
 */
export function splitUnconfiguredAnswers(configuredKeys: ReadonlySet<string>, submitted: Answers, stored: Answers) {
  const answers: Answers = {};
  const preserved: Answers = {};
  for (const [key, value] of Object.entries(submitted)) {
    if (!configuredKeys.has(key) && Object.hasOwn(stored, key) && sameAnswer(value, stored[key])) {
      preserved[key] = value;
    } else {
      answers[key] = value;
    }
  }
  return { answers, preserved };
}

/**
 * Drops validation issues on answers that didn't change: an existing
 * attendee's untouched answer, or an untouched registration answer. New
 * attendees and changed answers are checked in full.
 */
export function issuesOnChangedAnswers(
  issues: readonly PublicRegistrationIssue[],
  submittedRegistration: Answers,
  storedRegistration: Answers,
  attendees: ReadonlyArray<{ submitted: Answers; stored: Answers | null }>,
) {
  return issues.filter((issue) => {
    if (issue.code !== "INVALID_RESPONSE") return true;
    if (issue.attendeeIndex === null) {
      return !sameAnswer(submittedRegistration[issue.key], storedRegistration[issue.key]);
    }
    const attendee = attendees[issue.attendeeIndex];
    if (!attendee?.stored) return true;
    return !sameAnswer(attendee.submitted[issue.key], attendee.stored[issue.key]);
  });
}
