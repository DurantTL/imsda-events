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
  operation: "TRANSFER" | "ATTENDEE_SUBSTITUTION";
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
