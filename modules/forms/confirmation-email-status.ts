/**
 * What we can truthfully say about a registration confirmation email (#642).
 * One vocabulary for the public form's confirmation screen and the club
 * event page, so "registration saved" and "email delivered" are never
 * conflated: only SENT (accepted for delivery) reads as a delivery.
 */
export type ConfirmationEmailStatus = "PENDING" | "CAPTURED" | "SENT" | "FAILED" | "DISABLED";

/** Where a club is pointed when its confirmation email was not delivered. */
export const CLUB_SUPPORT_FALLBACK_EMAIL = "youth@imsda.org";

/**
 * Collapses outbox row statuses (newest first) into one display status.
 * The newest confirmation message speaks for the registration; no message,
 * or one that was suppressed or cancelled, means no email is going out.
 */
export function confirmationEmailStatusFromMessages(
  statuses: readonly string[],
): ConfirmationEmailStatus {
  const latest = statuses[0];
  if (latest === "SENT") return "SENT";
  if (latest === "CAPTURED") return "CAPTURED";
  if (latest === "FAILED") return "FAILED";
  if (latest === "PENDING" || latest === "PROCESSING") return "PENDING";
  return "DISABLED";
}

export function confirmationEmailHeadline(status: ConfirmationEmailStatus): string {
  switch (status) {
    case "SENT":
      return "Your confirmation email was accepted for delivery.";
    case "CAPTURED":
      return "A local confirmation preview was saved; no external email was sent.";
    case "PENDING":
      return "Your registration is saved and the confirmation email is queued.";
    case "FAILED":
      return "Your registration is saved, but the confirmation email could not be sent.";
    default:
      return "Your registration is saved. Email delivery is not enabled for this event.";
  }
}

export type ClubConfirmationEmailNotice = {
  status: ConfirmationEmailStatus;
  registrationSaved: string;
  email: string;
  /** Set when the email did not arrive as delivered; where to ask for help. */
  supportEmail: string | null;
};

/** The club card's two separate outcomes: registration saved, and email state. */
export function describeClubConfirmationEmail(
  status: ConfirmationEmailStatus,
  eventSupportContact: string | null | undefined,
): ClubConfirmationEmailNotice {
  const contact = eventSupportContact?.trim() ?? "";
  const supportEmail = contact.includes("@") && !/\s/.test(contact) ? contact : CLUB_SUPPORT_FALLBACK_EMAIL;
  const email = status === "SENT"
    ? "A confirmation email was accepted for delivery to the contact on the registration."
    : status === "CAPTURED"
      ? "A local confirmation preview was saved; no external email was sent."
      : status === "PENDING"
        ? "The confirmation email is queued and has not been delivered yet."
        : status === "FAILED"
          ? "The confirmation email could not be sent."
          : "No confirmation email is being sent for this registration.";
  return {
    status,
    registrationSaved: "Your club's registration is saved.",
    email,
    supportEmail: status === "SENT" || status === "CAPTURED" ? null : supportEmail,
  };
}
