import "server-only";

import { createHash } from "node:crypto";

type OperationIdentity = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function registrationOperationFingerprint(input: {
  eventId: string;
  registrationId: string;
  attendeeId?: string;
  operation: "TRANSFER" | "ATTENDEE_SUBSTITUTION" | "AMENDMENT";
  payload: Record<string, unknown>;
}) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(input)))
    .digest("hex");
}

function normalized(value: string) {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

export function identitiesDescribeSamePerson(
  left: OperationIdentity,
  right: OperationIdentity,
) {
  const sameName = normalized(left.firstName) === normalized(right.firstName)
    && normalized(left.lastName) === normalized(right.lastName);
  if (!sameName) return false;

  const leftEmail = normalized(left.email);
  const rightEmail = normalized(right.email);
  if (leftEmail || rightEmail) {
    return Boolean(leftEmail && rightEmail && leftEmail === rightEmail);
  }

  const leftPhone = normalized(left.phone);
  const rightPhone = normalized(right.phone);
  if (leftPhone || rightPhone) {
    return Boolean(leftPhone && rightPhone && leftPhone === rightPhone);
  }
  return true;
}

/** Attendee answers that carry a whole name; contact-name keys belong to the registration. */
const attendeeFullNameKeys = ["full_name", "name", "attendee_name", "guest_name", "member_name"] as const;

/**
 * An attendee's form answers after a substitution (WR26): the name, email,
 * and phone answers the attendee already had now describe the replacement,
 * so rosters, exports, and later edits don't keep showing the prior person.
 * Answers the attendee never had are not added; everything else is kept.
 */
export function substitutedFormResponses(
  responses: Record<string, unknown>,
  replacement: { firstName: string; lastName: string; email?: string | null; phone?: string | null },
) {
  const next = { ...responses };
  if (Object.hasOwn(next, "first_name")) next.first_name = replacement.firstName;
  if (Object.hasOwn(next, "last_name")) next.last_name = replacement.lastName;
  for (const key of attendeeFullNameKeys) {
    if (Object.hasOwn(next, key)) next[key] = `${replacement.firstName} ${replacement.lastName}`.trim();
  }
  if (Object.hasOwn(next, "attendee_email")) next.attendee_email = replacement.email || "";
  if (Object.hasOwn(next, "attendee_phone")) next.attendee_phone = replacement.phone || "";
  return next;
}
