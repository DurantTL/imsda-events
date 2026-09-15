import type { RegistrationRecord } from "@/modules/registrations/repository";

/**
 * Finds people and registrations that look like the same person twice.
 *
 * Duplicates are made by ordinary behavior, not by mistakes in the system: a
 * registrant whose card failed starts over rather than returning to their
 * link, a group leader adds someone who already registered themselves, and a
 * household is entered once by each of two people. Nobody sees it until
 * check-in hands out two badges or a balance reminder chases a person who has
 * already paid on their other registration.
 *
 * This reports; it never merges. Deciding which of two registrations is the
 * real one touches payments, capacity, and someone's place at the event, so
 * it stays a staff decision made in the registration and finance workspaces.
 */

/** Statuses that still hold a place. A cancelled registration is not a double. */
const countedStatuses = new Set(["SUBMITTED", "CONFIRMED", "WAITLISTED"]);

export type DuplicateMatchConfidence = "LIKELY" | "POSSIBLE";

export type DuplicateAttendeeMember = {
  registrationId: string;
  confirmationCode: string;
  registrationStatus: string;
  attendeeId: string;
  name: string;
  email: string;
  phone: string;
  attendeeType: string;
  checkedIn: boolean;
  balanceCents: number;
  submittedAt: string | null;
};

export type DuplicateAttendeeGroup = {
  key: string;
  confidence: DuplicateMatchConfidence;
  reason: string;
  members: DuplicateAttendeeMember[];
  /** True when every member sits on one registration — a repeated row, not a
   * second booking. It is the easiest kind to fix and the easiest to miss. */
  withinSingleRegistration: boolean;
};

export type DuplicateRegistrationMember = {
  registrationId: string;
  confirmationCode: string;
  status: string;
  contactName: string;
  email: string;
  phone: string;
  attendeeCount: number;
  totalAmountCents: number;
  paidCents: number;
  balanceCents: number;
  submittedAt: string | null;
};

export type DuplicateRegistrationGroup = {
  key: string;
  confidence: DuplicateMatchConfidence;
  reason: string;
  members: DuplicateRegistrationMember[];
};

export type DuplicateReport = {
  attendeeGroups: DuplicateAttendeeGroup[];
  registrationGroups: DuplicateRegistrationGroup[];
  scannedRegistrationCount: number;
  scannedAttendeeCount: number;
  duplicatedAttendeeCount: number;
};

/**
 * Folds accents, drops punctuation, and collapses spacing so "O'Brien",
 * "OBrien", and "o brien" land on one key. Hyphenated and accented names are
 * ordinary here, and a comparison that splits them finds nothing.
 */
export function normalizeNamePart(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

/**
 * The last ten digits, which is what makes "(515) 555-0134",
 * "515-555-0134", and "+1 515 555 0134" the same number. Anything shorter is
 * treated as no phone rather than matched loosely.
 */
export function normalizePhone(value: string) {
  const digits = value.replace(/\D+/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

/**
 * Sorted, so a registration entered as "Alvarez, Marta" still matches one
 * entered as "Marta Alvarez". Swapped name fields are one of the most common
 * ways the same person is entered twice and never noticed.
 */
export function normalizeNameKey(firstName: string, lastName: string) {
  const parts = [normalizeNamePart(firstName), normalizeNamePart(lastName)]
    .filter((part) => part.length > 0)
    .sort();
  return parts.length === 2 ? parts.join("|") : "";
}

function displayName(firstName: string, lastName: string) {
  return `${firstName} ${lastName}`.replace(/\s+/g, " ").trim();
}

function groupBy<T>(items: T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    if (!value) continue;
    const bucket = groups.get(value);
    if (bucket) bucket.push(item);
    else groups.set(value, [item]);
  }
  return groups;
}

/**
 * Signatures let a weaker rule stay quiet when a stronger one already
 * reported the same people. Matching on name alone is useful, but reporting
 * it a second time next to the email match it duplicates is what makes a
 * duplicate report get ignored.
 */
function membershipSignature(ids: string[]) {
  return [...ids].sort().join(",");
}

type MatchKeys = { emailKey: string; nameKey: string; phoneKey: string };
type AttendeeRow = { member: DuplicateAttendeeMember; keys: MatchKeys };

function attendeeRows(registrations: RegistrationRecord[]): AttendeeRow[] {
  return registrations.flatMap((registration) => (
    registration.attendees.map((attendee) => ({
      member: {
        registrationId: registration.id,
        confirmationCode: registration.confirmationCode,
        registrationStatus: registration.status,
        attendeeId: attendee.id,
        name: displayName(attendee.firstName, attendee.lastName),
        email: attendee.email,
        phone: attendee.phone,
        attendeeType: attendee.attendeeType,
        checkedIn: attendee.checkedIn,
        balanceCents: registration.balanceCents,
        submittedAt: registration.submittedAt,
      },
      keys: {
        emailKey: normalizeEmail(attendee.email),
        nameKey: normalizeNameKey(attendee.firstName, attendee.lastName),
        phoneKey: normalizePhone(attendee.phone),
      },
    }))
  ));
}

function sortMembers<T extends { submittedAt: string | null; confirmationCode: string }>(
  members: T[],
) {
  return [...members].sort((left, right) => (
    (left.submittedAt ?? "").localeCompare(right.submittedAt ?? "")
    || left.confirmationCode.localeCompare(right.confirmationCode)
  ));
}

function byConfidenceThenSize(
  left: { confidence: DuplicateMatchConfidence; members: unknown[]; key: string },
  right: { confidence: DuplicateMatchConfidence; members: unknown[]; key: string },
) {
  if (left.confidence !== right.confidence) return left.confidence === "LIKELY" ? -1 : 1;
  return right.members.length - left.members.length
    || left.key.localeCompare(right.key);
}

function buildAttendeeGroups(rows: AttendeeRow[]): DuplicateAttendeeGroup[] {
  const rules: Array<{
    confidence: DuplicateMatchConfidence;
    reason: string;
    key: (keys: MatchKeys) => string;
  }> = [
    {
      confidence: "LIKELY",
      reason: "Same email address",
      key: (keys) => keys.emailKey,
    },
    {
      confidence: "LIKELY",
      reason: "Same name and phone number",
      key: (keys) => (keys.nameKey && keys.phoneKey ? `${keys.nameKey}#${keys.phoneKey}` : ""),
    },
    {
      confidence: "POSSIBLE",
      reason: "Same name",
      key: (keys) => keys.nameKey,
    },
  ];

  const seen = new Set<string>();
  const groups: DuplicateAttendeeGroup[] = [];
  for (const rule of rules) {
    for (const [key, rowGroup] of groupBy(rows, (row) => rule.key(row.keys))) {
      if (rowGroup.length < 2) continue;
      const members = sortMembers(rowGroup.map((row) => row.member));
      const signature = membershipSignature(members.map((member) => member.attendeeId));
      if (seen.has(signature)) continue;
      seen.add(signature);
      groups.push({
        key: `${rule.reason}:${key}`,
        confidence: rule.confidence,
        reason: rule.reason,
        withinSingleRegistration: new Set(
          members.map((member) => member.registrationId),
        ).size === 1,
        members,
      });
    }
  }
  return groups.sort(byConfidenceThenSize);
}

type RegistrationRow = { member: DuplicateRegistrationMember; keys: MatchKeys };

function registrationRows(registrations: RegistrationRecord[]): RegistrationRow[] {
  return registrations.map((registration) => ({
    member: {
      registrationId: registration.id,
      confirmationCode: registration.confirmationCode,
      status: registration.status,
      contactName: displayName(
        registration.accountHolder.firstName,
        registration.accountHolder.lastName,
      ),
      email: registration.accountHolder.email,
      phone: registration.accountHolder.phone,
      attendeeCount: registration.attendeeCount,
      totalAmountCents: registration.totalAmountCents,
      paidCents: registration.paidCents,
      balanceCents: registration.balanceCents,
      submittedAt: registration.submittedAt,
    },
    keys: {
      emailKey: normalizeEmail(registration.accountHolder.email),
      nameKey: normalizeNameKey(
        registration.accountHolder.firstName,
        registration.accountHolder.lastName,
      ),
      phoneKey: normalizePhone(registration.accountHolder.phone),
    },
  }));
}

function buildRegistrationGroups(rows: RegistrationRow[]): DuplicateRegistrationGroup[] {
  const rules: Array<{
    confidence: DuplicateMatchConfidence;
    reason: string;
    key: (keys: MatchKeys) => string;
  }> = [
    {
      confidence: "LIKELY",
      reason: "Same contact email",
      key: (keys) => keys.emailKey,
    },
    {
      confidence: "POSSIBLE",
      reason: "Same contact name and phone number",
      key: (keys) => (keys.nameKey && keys.phoneKey ? `${keys.nameKey}#${keys.phoneKey}` : ""),
    },
  ];

  const seen = new Set<string>();
  const groups: DuplicateRegistrationGroup[] = [];
  for (const rule of rules) {
    for (const [key, rowGroup] of groupBy(rows, (row) => rule.key(row.keys))) {
      if (rowGroup.length < 2) continue;
      const members = sortMembers(rowGroup.map((row) => row.member));
      const signature = membershipSignature(members.map((member) => member.registrationId));
      if (seen.has(signature)) continue;
      seen.add(signature);
      groups.push({
        key: `${rule.reason}:${key}`,
        confidence: rule.confidence,
        reason: rule.reason,
        members,
      });
    }
  }
  return groups.sort(byConfidenceThenSize);
}

export function buildDuplicateReport(
  registrations: RegistrationRecord[],
): DuplicateReport {
  const counted = registrations.filter(
    (registration) => countedStatuses.has(registration.status),
  );
  const rows = attendeeRows(counted);
  const attendeeGroups = buildAttendeeGroups(rows);
  const registrationGroups = buildRegistrationGroups(registrationRows(counted));
  const duplicatedAttendeeIds = new Set(
    attendeeGroups.flatMap((group) => group.members.map((member) => member.attendeeId)),
  );
  return {
    attendeeGroups,
    registrationGroups,
    scannedRegistrationCount: counted.length,
    scannedAttendeeCount: rows.length,
    duplicatedAttendeeCount: duplicatedAttendeeIds.size,
  };
}
