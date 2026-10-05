import {
  CHOICE_FILTER_UNANSWERED,
  type ChoiceMatch,
} from "@/modules/registrations/choice-answer-filter";

/**
 * "Email these people" on the Filter by answer results (#783). Client-safe and
 * pure: it only shapes the audience and a starting draft for the existing
 * "Email selected" composer. Nothing here sends; staff review the preview,
 * may edit the draft, and press Send themselves.
 */

/** The composer accepts at most this many registrations in one batch. */
export const CHOICE_EMAIL_MAX_REGISTRATIONS = 250;

/** Each registration once, in result order, even when several attendees on it match. */
export function choiceEmailRegistrationIds(matches: readonly Pick<ChoiceMatch, "registrationId">[]): string[] {
  return [...new Set(matches.map((match) => match.registrationId))];
}

export type ChoiceEmailDraft = {
  templateKey: "EVENT_ANNOUNCEMENT";
  title: string;
  body: string;
};

const TITLE_LIMIT = 120;
const BODY_LIMIT = 4_000;

/**
 * A suggested announcement for people with no answer to a question. The
 * announcement template already ends with each recipient's own private
 * "Review your registration" link (the manage-link merge field), so the body
 * points at that link instead of carrying a URL. Other selected values get no
 * draft: there is nothing to ask of someone who has answered.
 */
export function choiceEmailDraft(input: { questionLabel: string; value: string | null }): ChoiceEmailDraft | null {
  if (input.value !== CHOICE_FILTER_UNANSWERED) return null;
  const label = input.questionLabel.trim() || "this question";
  const prefix = "Please add your answer: ";
  const title = `${prefix}${label}`.slice(0, TITLE_LIMIT).trimEnd();
  const body = [
    `We do not have your answer to "${label}" yet.`,
    "",
    "Please use the link below to open your registration and make your selection. It takes only a minute, and it helps us plan for you.",
    "",
    "If you have already answered, or you are not sure which choice to make, you can ignore this message or reply and we will help.",
  ].join("\n").slice(0, BODY_LIMIT);
  return { templateKey: "EVENT_ANNOUNCEMENT", title, body };
}
