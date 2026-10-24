import { z } from "zod";
import { newPhoneSchema } from "@/lib/field-validation";

/**
 * Personal staff invitations (#804). Pure rules, shared by the server, the pages and the tests.
 *
 * The office imports a CSV of email addresses; each address becomes one personal link that allows exactly one registration (the
 * person and their eligible family) for $0. A person (never automation) sends the invitation emails. Registrations made through
 * a link wait for the office to approve them in one batch. Nothing here reads the database or sends anything.
 */

export const STAFF_INVITATION_GROUPS = ["STAFF", "PASTOR", "VOLUNTEER"] as const;
export type StaffInvitationGroupValue = (typeof STAFF_INVITATION_GROUPS)[number];

export const STAFF_INVITATION_GROUP_LABEL: Record<StaffInvitationGroupValue, string> = {
  STAFF: "Staff",
  PASTOR: "Pastor",
  VOLUNTEER: "Volunteer",
};

/** The group as it is written in a sentence ("as a volunteer"). */
export function groupInSentence(group: StaffInvitationGroupValue) {
  return STAFF_INVITATION_GROUP_LABEL[group].toLowerCase();
}

/** What a CSV cell may say for a group: the three names, singular or plural, in any case. */
export function parseInvitationGroup(value: string): StaffInvitationGroupValue | null {
  const text = value.trim().toLowerCase();
  if (text === "staff") return "STAFF";
  if (text === "pastor" || text === "pastors") return "PASTOR";
  if (text === "volunteer" || text === "volunteers") return "VOLUNTEER";
  return null;
}

/** The most rows one import takes, and the most characters of a file the page sends. */
export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_CHARACTERS = 200_000;
export const NAME_MAX = 80;
export const EMAIL_MAX = 254;

/** The one public path of a personal link. Private: never indexed, never cached, no referrer (see next.config.ts). */
export function invitationPath(token: string) {
  return `/staff-invite/${encodeURIComponent(token)}`;
}

export function invitationUrl(baseUrl: string, token: string) {
  return `${baseUrl.replace(/\/+$/, "")}${invitationPath(token)}`;
}

export const INVITATION_RATE_LIMIT_FORM = "staff-invite";

// ---------------------------------------------------------------------------------------------
// Email addresses
// ---------------------------------------------------------------------------------------------

const emailSchema = z.email();

/** An address as it is stored and compared: trimmed and lowercase. */
export function normalizeInvitationEmail(value: string) {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function isValidInvitationEmail(value: string) {
  return value.length <= EMAIL_MAX && emailSchema.safeParse(value).success;
}

// ---------------------------------------------------------------------------------------------
// What an import row can be
// ---------------------------------------------------------------------------------------------

/**
 * What the import found in one row. Only NEW rows are ever created, and only after the office confirms the preview.
 *
 * - `NEW`: a valid address nobody is invited under yet.
 * - `INVALID_EMAIL`, `INVALID_GROUP`, `NAME_TOO_LONG`: the row can't be used as written.
 * - `DUPLICATE_IN_FILE`: the same address appeared earlier in the file; the first one is used.
 * - `ALREADY_INVITED`: the event already has a personal link for the address (revoked or not).
 * - `ALREADY_REGISTERED`: that address already belongs to a person registered for the event.
 */
export const IMPORT_ROW_STATUSES = ["NEW", "INVALID_EMAIL", "INVALID_GROUP", "NAME_TOO_LONG", "DUPLICATE_IN_FILE", "ALREADY_INVITED", "ALREADY_REGISTERED"] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export const IMPORT_ROW_STATUS_LABEL: Record<ImportRowStatus, string> = {
  NEW: "Will be invited",
  INVALID_EMAIL: "Not a valid email address",
  INVALID_GROUP: "Group not recognized",
  NAME_TOO_LONG: "Name is too long",
  DUPLICATE_IN_FILE: "Repeated in this file",
  ALREADY_INVITED: "Already invited",
  ALREADY_REGISTERED: "Already registered",
};

export type ImportPreviewRow = {
  /** The row's line in the file, counting the header as line 1. */
  line: number;
  email: string;
  firstName: string;
  lastName: string;
  group: StaffInvitationGroupValue | null;
  status: ImportRowStatus;
};

export type ImportPreview = {
  rows: ImportPreviewRow[];
  counts: Record<ImportRowStatus, number>;
  /** How many invitations confirming will create: the NEW rows. */
  willCreate: number;
  /** Identifies exactly which invitations confirming creates, so a confirm can only ever create what was previewed. */
  digest: string;
};

/** Who already holds each address in the event: an existing invitation, or a registered person. Keys are normalized emails. */
export type ExistingEmails = {
  invited: ReadonlySet<string>;
  registered: ReadonlySet<string>;
};

// ---------------------------------------------------------------------------------------------
// Status in the invite list
// ---------------------------------------------------------------------------------------------

/** What the invite list shows for a person. `declined` and `approved` follow a registration; the rest describe the link. */
export const INVITATION_STATUSES = ["NOT_SENT", "SENT", "DELIVERY_FAILED", "REGISTERED", "APPROVED", "DECLINED", "REVOKED"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const INVITATION_STATUS_LABEL: Record<InvitationStatus, string> = {
  NOT_SENT: "Not sent",
  SENT: "Sent",
  DELIVERY_FAILED: "Delivery failed",
  REGISTERED: "Registered, waiting for approval",
  APPROVED: "Registered and approved",
  DECLINED: "Registered, declined",
  REVOKED: "Revoked",
};

/** Message states and provider reports that mean the email did not reach the person. */
const FAILED_MESSAGE_STATUSES = new Set(["FAILED", "SUPPRESSED", "CANCELLED"]);
const FAILED_PROVIDER_STATUSES = new Set(["BOUNCED", "FAILED", "COMPLAINED", "SUPPRESSED"]);

/**
 * Whether the office can re-invite this person (#1027): their registration was declined (or was cancelled while it waited, which
 * settles the invitation as declined), and nobody has already re-invited them. Re-inviting makes a new invitation with a new link.
 */
export function invitationReinvitable(input: { approval: "WAITING" | "APPROVED" | "DECLINED" | null; supersededAt: Date | string | null }) {
  return input.approval === "DECLINED" && !input.supersededAt;
}

export type InvitationStatusInput = {
  revokedAt: Date | string | null;
  registeredAt: Date | string | null;
  approval: "WAITING" | "APPROVED" | "DECLINED" | null;
  sentAt: Date | string | null;
  message: { status: string; providerDeliveryStatus: string | null } | null;
};

export function invitationStatus(input: InvitationStatusInput): InvitationStatus {
  if (input.revokedAt) return "REVOKED";
  if (input.registeredAt) {
    if (input.approval === "APPROVED") return "APPROVED";
    if (input.approval === "DECLINED") return "DECLINED";
    return "REGISTERED";
  }
  if (!input.sentAt) return "NOT_SENT";
  if (input.message && (FAILED_MESSAGE_STATUSES.has(input.message.status) || (input.message.providerDeliveryStatus !== null && FAILED_PROVIDER_STATUSES.has(input.message.providerDeliveryStatus)))) {
    return "DELIVERY_FAILED";
  }
  return "SENT";
}

/** Whether the link still lets the person register. */
export function invitationUsable(input: { revokedAt: Date | string | null; registeredAt: Date | string | null }) {
  return !input.revokedAt && !input.registeredAt;
}

// ---------------------------------------------------------------------------------------------
// The family a link covers
// ---------------------------------------------------------------------------------------------

/** Decided by the owner (Oct 6): a spouse plus children or dependants up to age 18. */
export const FAMILY_MAX_DEPENDANT_AGE = 18;
/** A guard on the form, not a policy: the most children one registration lists. */
export const FAMILY_MAX_DEPENDANTS = 12;

/** Everything a name may carry: its words, single spaced, no control characters. */
export function cleanName(value: string) {
  return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

const nameField = z.string().transform(cleanName).pipe(z.string().min(1, "Enter a name.").max(NAME_MAX, "That name is too long."));

export const invitationRegistrationSchema = z.object({
  firstName: nameField,
  lastName: nameField,
  /** Optional, and always a new value: the link form starts blank, so there is no stored phone to keep (#1193). Stored normalised. */
  phone: newPhoneSchema.default(""),
  spouse: z.object({ firstName: nameField, lastName: nameField }).strict().nullable().default(null),
  dependants: z.array(z.object({
    firstName: nameField,
    lastName: nameField,
    /** Age on the first day of the event. */
    age: z.number().int("Enter a whole number.").min(0, "Enter an age from 0.").max(FAMILY_MAX_DEPENDANT_AGE, `Only children and dependants up to age ${FAMILY_MAX_DEPENDANT_AGE} are covered.`),
  }).strict()).max(FAMILY_MAX_DEPENDANTS, `List at most ${FAMILY_MAX_DEPENDANTS} children.`).default([]),
  needsHousing: z.boolean().default(false),
  housingNote: z.string().trim().max(500, "Keep the note under 500 characters.").default(""),
  /**
   * The event's own attendee questions (#1027), one set of answers per person in the party, in party order (the invited person,
   * the spouse, then each child). The server decides which questions exist and drops everything else; see `event-questions.ts`.
   */
  answers: z.array(z.record(z.string().max(60), z.unknown())).max(2 + FAMILY_MAX_DEPENDANTS, "Too many answer sets.").default([]),
  /** A honeypot, like the public form's: a person leaves it empty. */
  website: z.literal("").optional(),
}).strict();

export type InvitationRegistrationInput = z.infer<typeof invitationRegistrationSchema>;

export type PartyMember = {
  role: "PRIMARY" | "SPOUSE" | "DEPENDANT";
  firstName: string;
  lastName: string;
  /** Known only for a dependant. */
  age: number | null;
  /** The registration attendee type the person is recorded as. */
  attendeeType: "WORKER" | "ATTENDEE" | "CHILD";
};

/** The people one registration holds, in order: the invited person, the spouse, then each child. */
export function partyOf(input: InvitationRegistrationInput): PartyMember[] {
  return [
    { role: "PRIMARY", firstName: input.firstName, lastName: input.lastName, age: null, attendeeType: "WORKER" },
    ...(input.spouse ? [{ role: "SPOUSE" as const, firstName: input.spouse.firstName, lastName: input.spouse.lastName, age: null, attendeeType: "ATTENDEE" as const }] : []),
    ...input.dependants.map((child) => ({ role: "DEPENDANT" as const, firstName: child.firstName, lastName: child.lastName, age: child.age, attendeeType: "CHILD" as const })),
  ];
}

/** Two people in one party with the same name would be one person entered twice. */
export function duplicatePartyName(party: readonly PartyMember[]) {
  const seen = new Set<string>();
  for (const member of party) {
    const key = `${member.firstName} ${member.lastName}`.toLowerCase();
    if (seen.has(key)) return `${member.firstName} ${member.lastName}`;
    seen.add(key);
  }
  return null;
}

/** How a covered person's meal choice is recorded: they pick nothing, because the conference pays for every meal. */
export const COVERED_MEAL_ANSWER = "Covered (staff)";

// ---------------------------------------------------------------------------------------------
// Words people read
// ---------------------------------------------------------------------------------------------

export const INVITATION_RECEIVED_MESSAGE =
  "We have your registration. The event office reviews staff, pastor and volunteer registrations and will confirm yours. There is no charge.";

export const INVITATION_UNAVAILABLE_MESSAGE =
  "This link isn't available. It may have been replaced or turned off. Contact the event office if you think that is a mistake.";

/** The line an invitation email gives about who is covered. */
export const COVERAGE_SENTENCE =
  `Registration is free for you and your immediate family: your spouse and your children or dependants up to age ${FAMILY_MAX_DEPENDANT_AGE}.`;

export function invitationEmail(input: { eventName: string; firstName: string; group: StaffInvitationGroupValue; url: string; supportContact: string | null }) {
  const greeting = input.firstName.trim() ? `Hello ${input.firstName.trim()},` : "Hello,";
  return {
    subject: `Your personal registration link for ${input.eventName}`,
    bodyText: [
      greeting,
      "",
      `You are invited to register for ${input.eventName} as a ${groupInSentence(input.group)}.`,
      "",
      COVERAGE_SENTENCE,
      "",
      `Your personal link: ${input.url}`,
      "",
      "This link is for you alone and works for one registration, so please don't forward it. The event office reviews every registration before it is confirmed.",
      ...(input.supportContact ? ["", `Questions? Contact ${input.supportContact}.`] : []),
    ].join("\n"),
  };
}

export function receivedEmail(input: { eventName: string; firstName: string; confirmationCode: string }) {
  return {
    subject: `We received your registration for ${input.eventName}`,
    bodyText: [
      input.firstName.trim() ? `Hello ${input.firstName.trim()},` : "Hello,",
      "",
      `We received your registration for ${input.eventName}. The event office reviews staff, pastor and volunteer registrations and will let you know when yours is approved. There is no charge.`,
      "",
      `Reference: ${input.confirmationCode}`,
    ].join("\n"),
  };
}

export function approvedEmail(input: { eventName: string; firstName: string; confirmationCode: string }) {
  return {
    subject: `Your registration for ${input.eventName} is approved`,
    bodyText: [
      input.firstName.trim() ? `Hello ${input.firstName.trim()},` : "Hello,",
      "",
      `The event office approved your registration for ${input.eventName}. There is no charge for you or your immediate family.`,
      "",
      "Housing is assigned by the office closer to the event, and you will hear from them about it.",
      "",
      `Reference: ${input.confirmationCode}`,
    ].join("\n"),
  };
}

/** The office hears about waiting registrations in one digest per event per window, never one email per person. */
export const OFFICE_DIGEST_WINDOW_MS = 15 * 60 * 1000;

export function officeDigestWindow(now: Date) {
  return Math.floor(now.getTime() / OFFICE_DIGEST_WINDOW_MS);
}

export function officeDigestEmail(input: { eventName: string; waitingCount: number; reviewUrl: string }) {
  return {
    subject: `Staff registrations waiting for approval: ${input.eventName}`,
    bodyText: [
      `${input.waitingCount} ${input.waitingCount === 1 ? "registration is" : "registrations are"} waiting for approval for ${input.eventName} (made through personal staff, pastor and volunteer links).`,
      "",
      `Review them: ${input.reviewUrl}`,
      "",
      "You get at most one of these emails every 15 minutes for the event.",
    ].join("\n"),
  };
}
