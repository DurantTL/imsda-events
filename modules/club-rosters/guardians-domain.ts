import { z } from "zod";

/**
 * Guardian contacts on club roster members (#510). Pure rules: the shape, light
 * validation, and who may read or change them. Nothing here touches the
 * database, so the roster dialog and the server agree on the same checks.
 *
 * Director decision (Oct 1 and Oct 3, 2026): up to two guardians per member,
 * each with a name, relationship, email and cell phone, every field optional,
 * stored as plain text (not encrypted). Readable by the club's director and
 * deputy (who also edit), by every Area Coordinator, and by conference staff
 * holding VIEW_SENSITIVE_DATA. Nobody else.
 */

export const GUARDIAN_SLOTS = 2;

export const GUARDIAN_FIELDS = ["name", "relationship", "email", "phone"] as const;
export type GuardianField = (typeof GUARDIAN_FIELDS)[number];

export const guardianFieldLabels: Record<GuardianField, string> = {
  name: "Name",
  relationship: "Relationship",
  email: "Email",
  phone: "Cell phone",
};

export type GuardianValues = Record<GuardianField, string>;

/** One stored guardian: the slot (1 or 2) and its values. */
export type GuardianRecord = GuardianValues & { position: number };

export const EMPTY_GUARDIAN: GuardianValues = { name: "", relationship: "", email: "", phone: "" };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Light check, not a deliverability test: something@something.tld. */
export function guardianEmailProblem(value: string): string | null {
  const email = value.trim();
  if (!email) return null;
  return EMAIL_PATTERN.test(email) && email.length <= 254 ? null : "Enter an email like name@example.com.";
}

/**
 * Light check: digits with the usual separators, 7 to 15 digits, and an
 * optional extension ("x123" or "ext. 123"). No country-specific rules.
 */
export function guardianPhoneProblem(value: string): string | null {
  const phone = value.trim();
  if (!phone) return null;
  const main = phone.replace(/\s*(?:x|ext\.?)\s*\d{1,6}$/i, "");
  const digits = main.replace(/\D/g, "");
  const onlyPhoneCharacters = /^[0-9+().\-\s]+$/.test(main);
  return onlyPhoneCharacters && digits.length >= 7 && digits.length <= 15 ? null : "Enter a phone number like (555) 123-4567.";
}

const text = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters.`).default("");

export const guardianInputSchema = z.object({
  name: text(120),
  relationship: text(60),
  email: text(254).refine((value) => guardianEmailProblem(value) === null, { message: "Enter an email like name@example.com." }),
  phone: text(40).refine((value) => guardianPhoneProblem(value) === null, { message: "Enter a phone number like (555) 123-4567." }),
}).strict();

/**
 * The guardian set sent with a roster add or edit: slot 1 first, slot 2
 * second. It replaces the member's whole set, so a blank slot (or a slot left
 * out) removes that guardian. Leaving `guardians` out of the request leaves
 * the stored guardians alone.
 */
export const guardiansInputSchema = z.array(guardianInputSchema).max(GUARDIAN_SLOTS, "A member can have two guardians at most.");

export type GuardianInput = z.infer<typeof guardianInputSchema>;

export function guardianIsBlank(guardian: GuardianValues) {
  return GUARDIAN_FIELDS.every((field) => !guardian[field].trim());
}

/** The non-blank guardians of a request, each with its slot number (1 or 2). */
export function guardianSlotsFrom(guardians: readonly GuardianValues[]): GuardianRecord[] {
  return guardians
    .slice(0, GUARDIAN_SLOTS)
    .map((guardian, index) => ({
      position: index + 1,
      name: guardian.name.trim(),
      relationship: guardian.relationship.trim(),
      email: guardian.email.trim(),
      phone: guardian.phone.trim(),
    }))
    .filter((guardian) => !guardianIsBlank(guardian));
}

/** Inline errors for the dialog, keyed `g1Email`, `g2Phone` and so on. */
export type GuardianFormErrors = Partial<Record<`g${1 | 2}${"Email" | "Phone"}`, string>>;

export function validateGuardianForm(guardians: readonly Pick<GuardianValues, "email" | "phone">[]): GuardianFormErrors {
  const errors: GuardianFormErrors = {};
  guardians.slice(0, GUARDIAN_SLOTS).forEach((guardian, index) => {
    const slot = (index + 1) as 1 | 2;
    const email = guardianEmailProblem(guardian.email);
    const phone = guardianPhoneProblem(guardian.phone);
    if (email) errors[`g${slot}Email`] = email;
    if (phone) errors[`g${slot}Phone`] = phone;
  });
  return errors;
}

/** The stored guardians as two dialog slots, filling gaps with blanks. */
export function guardianSlotValues(records: readonly GuardianRecord[] | undefined): GuardianValues[] {
  return Array.from({ length: GUARDIAN_SLOTS }, (_, index) => {
    const found = records?.find((record) => record.position === index + 1);
    return found
      ? { name: found.name, relationship: found.relationship, email: found.email, phone: found.phone }
      : { ...EMPTY_GUARDIAN };
  });
}

// ---------------------------------------------------------------------------
// Who may see or change them

export type GuardianActor =
  | { kind: "ATTENDEE"; accountId: string }
  | { kind: "STAFF_ACTING"; userId: string; actAsId: string };

export type GuardianViewer =
  /** The club's own director or deputy (or staff acting as the director): that club only, read and edit. */
  | { kind: "CLUB_LEADER"; organizationId: string; actor: GuardianActor }
  /** Any Area Coordinator, for every club, read only: coordinators need them during events. */
  | { kind: "AREA_COORDINATOR"; actor: GuardianActor }
  /** Conference staff holding VIEW_SENSITIVE_DATA (or a system administrator), read only. */
  | { kind: "STAFF"; userId: string };

/** Read access. A club leader reads their own club only. */
export function guardianViewerCanRead(viewer: GuardianViewer, organizationId: string) {
  return viewer.kind === "CLUB_LEADER" ? viewer.organizationId === organizationId : true;
}

/** Edit access: only the club's own director and deputy, for their own club. */
export function guardianViewerCanEdit(viewer: GuardianViewer, organizationId: string) {
  return viewer.kind === "CLUB_LEADER" && viewer.organizationId === organizationId;
}

/**
 * Conference staff who may read guardians: a system administrator, or anyone
 * whose active event membership carries VIEW_SENSITIVE_DATA (through its role
 * or an explicit grant). `eventId` narrows it to one event's membership, for a
 * page that is scoped to one event.
 */
export function staffHoldsSensitiveData(
  user: { globalRole?: string | null },
  memberships: ReadonlyArray<{ eventId: string; status: string; permissions: readonly string[]; roleHasSensitiveData: boolean }>,
  eventId?: string,
) {
  if (user.globalRole === "SYSTEM_ADMIN") return true;
  return memberships.some((membership) => membership.status === "ACTIVE"
    && (eventId === undefined || membership.eventId === eventId)
    && (membership.roleHasSensitiveData || membership.permissions.includes("VIEW_SENSITIVE_DATA")));
}

/** Who did it, as audit fields. No guardian value is ever part of this. */
export function guardianAuditActor(viewer: GuardianViewer): { actorUserId?: string; metadata: Record<string, string> } {
  if (viewer.kind === "STAFF") return { actorUserId: viewer.userId, metadata: { viewerKind: viewer.kind } };
  return viewer.actor.kind === "ATTENDEE"
    ? { metadata: { viewerKind: viewer.kind, actorAttendeeAccountId: viewer.actor.accountId } }
    : { actorUserId: viewer.actor.userId, metadata: { viewerKind: viewer.kind, actAsId: viewer.actor.actAsId } };
}
