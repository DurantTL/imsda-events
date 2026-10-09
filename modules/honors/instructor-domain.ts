/**
 * Honors Weekend class instructors (#833). Pure rules: who may see a roster,
 * until when marks may change, what an instructor is allowed to see of a
 * person, and how one-click marks change a class. No database here.
 *
 * Decisions (Caleb, Oct 8, 2026): staff assign and invite instructors; an
 * instructor sees name and club only; Completed also marks attended; marks may
 * change until 14 days after the event ends; a current Sterling Volunteers
 * check is needed to see a roster.
 */

/** Marks may change until this many days after the event ends. */
export const INSTRUCTOR_EDIT_GRACE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export function instructorEditDeadline(eventEndsAt: Date) {
  return new Date(eventEndsAt.getTime() + INSTRUCTOR_EDIT_GRACE_DAYS * DAY_MS);
}

export function instructorMarksOpen(eventEndsAt: Date, now: Date) {
  return now.getTime() <= instructorEditDeadline(eventEndsAt).getTime();
}

/** Shown in place of a roster when the instructor has no current Sterling Volunteers check. */
export const STERLING_REQUIRED_MESSAGE =
  "You need a current Sterling Volunteers check on file before you can see a class roster. "
  + "If you believe yours is current, contact the conference office so it can be matched to you.";

/** The Sterling Volunteers states (`backgroundCheckState`) that let an instructor see a roster. */
export function sterlingAllowsRoster(state: "CURRENT" | "EXPIRED" | "MISSING" | "NOT_COMPLIANT") {
  return state === "CURRENT";
}

/**
 * The only fields an instructor ever receives for a person. The repository
 * builds rows with `toInstructorRosterRow` and nothing else, so a field added
 * to the source records can never reach an instructor by accident.
 * `enrollmentId` is an opaque handle for the mark, not a person or registration id.
 */
export const INSTRUCTOR_ROSTER_ROW_KEYS = [
  "enrollmentId", "firstName", "lastName", "clubName", "attended", "completed", "recorded", "recordedVoided",
] as const;

export type InstructorRosterRow = {
  enrollmentId: string;
  firstName: string;
  lastName: string;
  /** The club's name; "Group registration" for a group, never a person's name. */
  clubName: string;
  attended: boolean;
  completed: boolean;
  /** Completed here and already written into the member's honor record: locked here; staff can void it. */
  recorded: boolean;
  /** Recorded, and every recorded entry has since been voided by staff. */
  recordedVoided: boolean;
};

export const GROUP_REGISTRATION_CLUB_LABEL = "Group registration";

export function toInstructorRosterRow(source: {
  enrollmentId: string;
  firstName: string;
  lastName: string;
  clubName: string | null;
  mark: { attended: boolean; completed: boolean } | null;
  links: ReadonlyArray<{ voided: boolean }>;
}): InstructorRosterRow {
  return {
    enrollmentId: source.enrollmentId,
    firstName: source.firstName,
    lastName: source.lastName,
    clubName: source.clubName ?? GROUP_REGISTRATION_CLUB_LABEL,
    attended: source.mark?.attended ?? false,
    completed: source.mark?.completed ?? false,
    recorded: source.links.length > 0,
    recordedVoided: source.links.length > 0 && source.links.every((link) => link.voided),
  };
}

export function sortInstructorRoster(rows: readonly InstructorRosterRow[]) {
  return [...rows].sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.clubName.localeCompare(b.clubName));
}

export type MarkState = { attended: boolean; completed: boolean };

/** A person's mark never says completed without attended. */
export function normalizeMark(input: MarkState): MarkState {
  return { attended: input.attended || input.completed, completed: input.completed };
}

/**
 * A single person's change. Completed also marks attended; taking attended
 * away takes completed away with it.
 */
export function applyPersonMark(current: MarkState, change: Partial<MarkState>): MarkState {
  const next = { ...current, ...change };
  if (change.completed === true) next.attended = true;
  if (change.attended === false) next.completed = false;
  return normalizeMark(next);
}

export const BULK_MARK_ACTIONS = ["ALL_ATTENDED", "ALL_COMPLETED", "CLEAR"] as const;
export type BulkMarkAction = (typeof BULK_MARK_ACTIONS)[number];

/**
 * What a one-click action does to one person who is not locked. "All attended"
 * keeps a completion that is already marked; "all completed" marks both;
 * "clear" removes the mark (the instructor has made no decision again).
 * Null means remove the mark.
 */
export function applyBulkMark(action: BulkMarkAction, current: MarkState): MarkState | null {
  if (action === "ALL_COMPLETED") return { attended: true, completed: true };
  if (action === "ALL_ATTENDED") return { attended: true, completed: current.completed };
  return null;
}

/**
 * A person whose completion is already written into the honor record cannot be
 * un-completed by an instructor (staff void it instead), so one-click actions
 * skip them unless the action would leave their completion in place.
 */
export function markChangeIsLocked(row: Pick<InstructorRosterRow, "recorded" | "completed">, next: MarkState | null) {
  return row.recorded && row.completed && !(next?.completed ?? false);
}

export type InstructorInviteInput = {
  name: string;
  email: string;
  eventName: string;
  classNames: readonly string[];
  signUpUrl: string;
  signInUrl: string;
};

/**
 * The invite email. It carries no secret: the invite is accepted from the
 * instructor's own signed-in account, and only when its verified email is this
 * address (the same rule as a club invite, #376).
 */
export function instructorInviteEmail(input: InstructorInviteInput) {
  return {
    subject: `You're invited to teach at ${input.eventName} on IMSDA Events`,
    bodyText: [
      `Hello ${input.name.trim() || "there"},`,
      "",
      `The Iowa-Missouri Conference has invited you to teach at ${input.eventName}:`,
      ...input.classNames.map((name) => `- ${name}`),
      "",
      "To accept:",
      `1. New to IMSDA Events? Create your account at ${input.signUpUrl}`,
      `   Already have one? Sign in at ${input.signInUrl}`,
      `2. Use this email address: ${input.email}`,
      "3. On your account page, choose Accept next to the instructor invite.",
      "",
      "Once you accept, you'll see only your own classes. To see a class roster you also need a current Sterling Volunteers check on file; the conference office will tell you if anything is missing.",
      "",
      "If you weren't expecting this, you can ignore it. Nothing happens unless you accept.",
      "",
      "IMSDA Events",
    ].join("\n"),
  };
}

export type InstructorStatus = "INVITED" | "ACCEPTED" | "REMOVED";

export function instructorStatus(row: { acceptedAt: Date | null; revokedAt: Date | null }): InstructorStatus {
  if (row.revokedAt) return "REMOVED";
  return row.acceptedAt ? "ACCEPTED" : "INVITED";
}
