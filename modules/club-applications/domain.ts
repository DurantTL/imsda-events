import { z } from "zod";

/**
 * New club applications (#817). Client-safe: the public form imports the
 * wording and the schema, so nothing here may reach `node:` or the database.
 *
 * The application mirrors the conference's paper "Pathfinder Program Club
 * Application (For New Pathfinder Clubs only)". The two passages below are
 * shown on the form exactly as written on that paper form; do not edit them
 * without the conference's say-so.
 */

export const PHILOSOPHY_STATEMENT =
  "The purpose of having a Pathfinder club is to lead its membership into a growing, redemptive relationship with Christ, and to build its membership into responsible, mature individuals and to involve its membership in active selfless service. All Pathfinder leaders and Christians, working hand in hand with parents, teachers, and pastors providing optimum opportunities for Christian development. The Pathfinder club is an extension of the home, school, and church, it is an experimental laboratory where growth and learning flourish. The membership involves youth in grades 5-10 who have a desire for group activities ranging from community and world mission projects to nature, outdoor and camping activities, AY/Pathfindering class curriculum and AY honors. Above all, Pathfindering gives youth an environment in which to actively expand their personal experience with Christ.";

export const CHURCH_AGREEMENT =
  "We, the undersigned, have read, understand, and are in full agreement with the above philosophy of Pathfindering and agree to support our club through those means with which the Lord has blessed this church including finances, staff volunteers, securing a place to meet, transportation on outings, and other such needs as may arise in the fulfillment of this ministry, and to assist and support the work of the Pathfinder ministry in the conference, and around the world.";

export const NEW_CLUB_APPLICATION_STATUSES = ["PENDING", "APPROVED", "DECLINED"] as const;
export type NewClubApplicationStatusValue = (typeof NEW_CLUB_APPLICATION_STATUSES)[number];

export const NEW_CLUB_TYPES = ["PATHFINDER", "ADVENTURER"] as const;
export type NewClubTypeValue = (typeof NEW_CLUB_TYPES)[number];
export const newClubTypeLabels: Record<NewClubTypeValue, string> = {
  PATHFINDER: "Pathfinder club",
  ADVENTURER: "Adventurer club",
};

export const newClubApplicationStatusLabels: Record<NewClubApplicationStatusValue, string> = {
  PENDING: "Waiting for a decision",
  APPROVED: "Approved",
  DECLINED: "Declined",
};

/** The text kept on the new club's organization (`sourceOrgType`), the only place its kind is modeled today. */
export const newClubSourceOrgType: Record<NewClubTypeValue, string> = {
  PATHFINDER: "Pathfinder Club",
  ADVENTURER: "Adventurer Club",
};

export const MAX_APPLICATION_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_OTHER_BOARD_MEMBERS = 20;
export const DECLINE_REASON_MAX = 500;
/** How long a private "apply for a new club" link stays usable. */
export const NEW_CLUB_INVITE_LIFETIME_DAYS = 30;

const requiredText = (label: string, max: number, min = 2) =>
  z.string().trim().min(min, `${label} is required.`).max(max, `${label} must be ${max} characters or fewer.`);

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.string().max(max, `Keep this to ${max} characters or fewer.`),
  ).nullish().transform((value) => (value ? value : null));

/** The least time a person plausibly needs to fill in the whole form. Anything faster is treated as a bot. */
export const MIN_FILL_SECONDS = 4;

export function submittedTooQuickly(formOpenedAt: number, now: Date) {
  return now.getTime() - formOpenedAt < MIN_FILL_SECONDS * 1000;
}

/** Collapses runs of whitespace so "  Jo   Smith " and "Jo Smith" are the same name. */
export function cleanName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * What the public form sends. The application date is not here: the server
 * stamps today's date (conference time zone) itself, so it can't be back-dated.
 * `website` is the bot trap: a hidden field a person never fills in.
 */
export const newClubApplicationInputSchema = z.strictObject({
  clubName: requiredText("The club name", 120),
  clubType: z.enum(NEW_CLUB_TYPES, { error: "Choose Pathfinder or Adventurer." }),
  sponsoringChurchId: z.string().trim().max(60).nullish().transform((value) => value || null),
  sponsoringChurchOther: optionalText(160),
  pastorName: requiredText("The pastor's name", 120),
  directorName: requiredText("The director's name", 120),
  directorAddress: requiredText("The director's mailing address", 300, 5),
  directorEmail: z.string().trim().toLowerCase().pipe(z.email("Enter the director's email address.").max(160)),
  directorHomePhone: optionalText(40),
  directorWorkPhone: optionalText(40),
  philosophyAgreed: z.literal(true, { error: "Tick the box to confirm the church agrees." }),
  pastorSignature: requiredText("The pastor's signature", 120),
  headElderSignature: requiredText("The head elder's signature", 120),
  clerkSignature: requiredText("The church clerk's signature", 120),
  directorSignature: requiredText("The director's signature", 120),
  otherBoardMembers: z.array(requiredText("A board member's name", 120)).max(MAX_OTHER_BOARD_MEMBERS).default([]),
  note: optionalText(1000),
  /** When the form was opened (ms since the epoch). A person takes longer than a few seconds to fill it in; a script doesn't. */
  formOpenedAt: z.number().int().positive(),
  website: z.literal("").optional(),
}).superRefine((value, context) => {
  if (!value.sponsoringChurchId && !value.sponsoringChurchOther) {
    context.addIssue({ code: "custom", path: ["sponsoringChurchId"], message: "Choose the sponsoring church, or choose Other and type its name." });
  }
  if (value.sponsoringChurchId && value.sponsoringChurchOther) {
    context.addIssue({ code: "custom", path: ["sponsoringChurchOther"], message: "Choose a church from the list, or Other, not both." });
  }
  if (!value.directorHomePhone && !value.directorWorkPhone) {
    context.addIssue({ code: "custom", path: ["directorHomePhone"], message: "Give a home or work phone for the director." });
  }
});

export type NewClubApplicationInput = z.infer<typeof newClubApplicationInputSchema>;

export const newClubInviteInputSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.").max(160)),
  name: z.string().trim().max(120).optional().default(""),
});

export const newClubDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("approve"),
    /** Required when the applicant chose "Other": every club needs a sponsoring church from the directory. */
    sponsoringChurchId: z.string().trim().min(1).max(60).optional(),
  }),
  z.strictObject({
    decision: z.literal("decline"),
    declineReason: z.string().trim().max(DECLINE_REASON_MAX, `Keep the reason under ${DECLINE_REASON_MAX} characters.`).optional(),
  }),
]);

export type NewClubDecision = z.infer<typeof newClubDecisionSchema>;

/** Sterling Volunteers status of the applying director, using the roster's existing labels. */
export type DirectorBackgroundState = "CLEAR" | "FLAGGED" | "NOT_COMPLIANT" | "NO_RECORD";
export const directorBackgroundLabels: Record<DirectorBackgroundState, string> = {
  CLEAR: "Clear",
  FLAGGED: "Expiring soon",
  NOT_COMPLIANT: "Not in compliance",
  NO_RECORD: "No record",
};

export type DuplicateFlag = {
  kind: "SAME_NAME_AND_CHURCH" | "CHURCH_HAS_CLUB" | "PENDING_SAME_NAME";
  message: string;
};

/** The text of a possible-duplicate flag, kept here so the queue and its tests agree. */
export function duplicateMessage(kind: DuplicateFlag["kind"], subject: string) {
  switch (kind) {
    case "SAME_NAME_AND_CHURCH":
      return `A club named ${subject} already exists for this church.`;
    case "CHURCH_HAS_CLUB":
      return `This church already has a club: ${subject}.`;
    case "PENDING_SAME_NAME":
      return `Another application is waiting for a club named ${subject} at this church.`;
  }
}
