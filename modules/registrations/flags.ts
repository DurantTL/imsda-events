import type { RegistrationRecord } from "@/modules/registrations/repository";

/**
 * A flag is a condition the system derives from a registration's current
 * state — never a label staff apply (that is a tag). Flags are computed here,
 * on read, from data already loaded for the registration; nothing about a
 * flag is ever written to the database, so a flag can never go stale or
 * disagree with the record it describes.
 */
export const registrationFlagKinds = [
  "BALANCE_DUE",
  "MISSING_ATTENDEE_RESPONSES",
  "NO_ONLINE_PAYMENT_CONFIGURATION",
] as const;

export type RegistrationFlagKind = (typeof registrationFlagKinds)[number];

export type RegistrationFlag = {
  kind: RegistrationFlagKind;
  label: string;
  detail: string;
};

function centsToDisplay(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function computeRegistrationFlags(registration: RegistrationRecord): RegistrationFlag[] {
  const flags: RegistrationFlag[] = [];

  if (registration.balanceCents > 0) {
    flags.push({
      kind: "BALANCE_DUE",
      label: "Balance due",
      detail: `${centsToDisplay(registration.balanceCents)} outstanding.`,
    });
  }

  // Only meaningful for registrations built from a public form: staff-built
  // registrations rarely collect per-attendee responses at all.
  const missingAttendeeResponses = Boolean(registration.publicSubmission)
    && registration.attendees.some((attendee) => Object.keys(attendee.responses).length === 0);
  if (missingAttendeeResponses) {
    flags.push({
      kind: "MISSING_ATTENDEE_RESPONSES",
      label: "Missing attendee responses",
      detail: "At least one attendee has no recorded form responses.",
    });
  }

  if (registration.onlinePaymentUnavailable) {
    flags.push({
      kind: "NO_ONLINE_PAYMENT_CONFIGURATION",
      label: "Online payment unavailable",
      detail: "This registration has a balance due but no active published card-payment configuration, so the registrant's manage link cannot take a card payment. Publish the form's payment step or take payment by another method.",
    });
  }

  return flags;
}
