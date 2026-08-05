import {
  REGISTRATION_MANAGE_API_SENTINEL,
  REGISTRATION_MANAGE_LINK_SENTINEL,
} from "@/modules/communications/manage-link";
import { formatMessageMoney } from "@/modules/communications/templates";

/**
 * Server-generated Markdown sections. A template author places one token and
 * gets the section that matches the event's configuration and the
 * registration's actual payment state, instead of writing conditionals into a
 * template or maintaining one template per state.
 *
 * Every builder returns Markdown, never HTML: the same string is the plain-text
 * body and the source the HTML renderer escapes, so a block can never introduce
 * markup and can never say one thing in one body and another in the other.
 *
 * A block that has nothing to say returns "" — an event with no lodging, or a
 * registration with no check-in pass, simply omits the section.
 */

/** Prisma selection for the lodging an event renders into its messages. */
export const EVENT_LODGING_SELECT = {
  hotelName: true,
  hotelBookingUrl: true,
  hotelPhone: true,
  hotelGroupName: true,
  hotelRate: true,
  hotelInstructions: true,
} as const;

export type EventLodging = {
  hotelName?: string | null;
  hotelBookingUrl?: string | null;
  hotelPhone?: string | null;
  hotelGroupName?: string | null;
  hotelRate?: string | null;
  hotelInstructions?: string | null;
};

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Markdown link text and URLs are delimited by brackets and parentheses, so a
 * configured value carrying one would break out of the link it sits in. Both
 * sides are neutralised rather than dropped, which keeps a hotel name readable
 * while keeping the link intact.
 */
function linkText(value: string) {
  return value.replace(/[[\]]/g, "");
}

function linkUrl(value: string) {
  const url = value.trim();
  if (/[\s()<>"']/.test(url)) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

export function buildHotelInformationBlock(lodging: EventLodging | null | undefined) {
  if (!lodging) return "";
  const name = clean(lodging.hotelName);
  if (!name) return "";

  const bookingUrl = clean(lodging.hotelBookingUrl);
  const safeBookingUrl = bookingUrl ? linkUrl(bookingUrl) : null;
  const phone = clean(lodging.hotelPhone);
  const groupName = clean(lodging.hotelGroupName);
  const rate = clean(lodging.hotelRate);
  const instructions = clean(lodging.hotelInstructions);

  const lines = ["### Hotel reservations", "", `A block of rooms is held at **${linkText(name)}**.`, ""];
  if (safeBookingUrl) {
    lines.push(`- Reserve online: [Book your room](${safeBookingUrl})`);
  } else if (bookingUrl) {
    lines.push(`- Reserve online: ${bookingUrl}`);
  }
  if (phone) lines.push(`- By phone: ${phone}`);
  if (groupName) lines.push(`- Ask for the group: ${groupName}`);
  if (rate) lines.push(`- Group rate: ${rate}`);
  if (lines[lines.length - 1] !== "") lines.push("");
  if (instructions) {
    lines.push(instructions, "");
  }
  return lines.join("\n").trimEnd();
}

export type PaymentState =
  | "PAID"
  | "BALANCE_DUE"
  | "COMPLIMENTARY"
  | "WAITLISTED"
  | "WAITLIST_PROMOTED"
  | "CANCELLED"
  | "ORGANIZATION_INVOICED";

export type PaymentStatusBlockInput = {
  state: PaymentState;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  waitlistPosition?: number | null;
  /** Event-configured wording for how to pay. Appended when a balance remains. */
  paymentInstructions?: string | null;
  /** Rendered as a link when a balance remains. Usually the private portal URL. */
  portalUrl?: string | null;
  /** Refund and payment wording for a cancelled registration. */
  cancellationNote?: string | null;
  /** The club/church responsible for a deferred-organization registration. */
  organization?: string | null;
  /** The billing contact for a deferred-organization registration, separate from the submitter. */
  billingContact?: string | null;
};

/**
 * `totalCents` of zero with nothing paid is a complimentary registration, not a
 * paid one: telling someone their $0.00 payment was received reads as an error.
 * Callers that already know the registration is comped can say so directly.
 */
export function resolvePaymentState(input: {
  totalCents: number;
  balanceCents: number;
  isWaitlisted?: boolean;
  isPromotedFromWaitlist?: boolean;
  isCancelled?: boolean;
}): PaymentState {
  if (input.isCancelled) return "CANCELLED";
  if (input.isWaitlisted) return "WAITLISTED";
  if (input.isPromotedFromWaitlist) return "WAITLIST_PROMOTED";
  if (input.totalCents <= 0) return "COMPLIMENTARY";
  return input.balanceCents > 0 ? "BALANCE_DUE" : "PAID";
}

export function buildPaymentStatusBlock(input: PaymentStatusBlockInput) {
  const total = formatMessageMoney(Math.max(input.totalCents, 0));
  const paid = formatMessageMoney(Math.max(input.paidCents, 0));
  const balance = formatMessageMoney(Math.max(input.balanceCents, 0));
  const instructions = clean(input.paymentInstructions);
  const portalUrl = clean(input.portalUrl);

  if (input.state === "WAITLISTED") {
    const position = input.waitlistPosition && input.waitlistPosition > 0
      ? `You are number **${input.waitlistPosition}** on the waitlist.`
      : "Your place on the waitlist is being confirmed.";
    return [
      "### Waitlist status",
      "",
      position,
      "",
      "**No payment is due and nothing has been charged.** Please do not send payment unless we confirm that a place is available.",
    ].join("\n");
  }

  if (input.state === "WAITLIST_PROMOTED") {
    const lines = [
      "### A place is available",
      "",
      `Your registration moved off the waitlist. Registration total: **${total}**. Balance due: **${balance}**.`,
    ];
    if (input.balanceCents > 0) {
      if (instructions) lines.push("", instructions);
      if (portalUrl) lines.push("", `[Pay your balance](${portalUrl})`);
    } else {
      lines.push("", "No payment is due.");
    }
    return lines.join("\n");
  }

  if (input.state === "CANCELLED") {
    return [
      "### Payment and refund status",
      "",
      clean(input.cancellationNote)
        ?? `${paid} in payments is recorded against a registration total of ${total}.`,
    ].join("\n");
  }

  if (input.state === "ORGANIZATION_INVOICED") {
    const organization = clean(input.organization);
    const billingContact = clean(input.billingContact);
    const lines = [
      "### Payment status",
      "",
      "**No payment is due online.** This event bills the responsible organization directly. The organization will receive an invoice after the event based on final attendance.",
      "",
      `Published rate reference: **${total}**. This is an estimate, not an amount due from you.`,
    ];
    if (organization) lines.push("", `Responsible organization: **${organization}**`);
    if (billingContact) lines.push(`Billing contact: **${billingContact}**`);
    return lines.join("\n");
  }

  if (input.state === "COMPLIMENTARY") {
    return [
      "### Payment status",
      "",
      "**This registration is complimentary.** No payment is due and no card was charged.",
    ].join("\n");
  }

  if (input.state === "PAID") {
    return [
      "### Payment status",
      "",
      `**Paid in full — thank you.** We received ${paid} against a registration total of ${total}. No balance remains.`,
    ].join("\n");
  }

  const lines = [
    "### Balance due",
    "",
    `Registration total: **${total}**`,
    `Payments received: **${paid}**`,
    `Balance due: **${balance}**`,
  ];
  if (instructions) lines.push("", instructions);
  if (portalUrl) lines.push("", `[Pay your balance](${portalUrl})`);
  return lines.join("\n");
}

export type CheckinBlockInput = {
  confirmationCode: string;
  /** Where the registrant can open the check-in pass for every attendee. */
  passUrl?: string | null;
  /**
   * Direct image URL for the pass QR code. Supply this only when the code
   * stands for the whole registration — one attendee's code checks in one
   * attendee, so a party is sent to the portal instead.
   */
  qrImageUrl?: string | null;
  /** How many attendees the registration covers, which decides the wording. */
  attendeeCount?: number;
};

/**
 * The check-in tokens for one registration, written against the delivery
 * sentinels so the private token only ever exists inside a sent message.
 *
 * A pass is per attendee: scanning one resolves that person and nobody else. So
 * a QR is inlined only when the registration has exactly one attendee, where
 * the code in the email is unambiguously that person's. A family or group gets
 * the portal link instead, which shows every attendee's own labelled pass —
 * inlining the first attendee's code there would check in one person and leave
 * the rest of the party looking at a code that is not theirs.
 *
 * `attendeeIds` is the whole party for that reason, not just the first.
 */
export function buildRegistrationCheckinTokens(input: {
  confirmationCode: string;
  attendeeIds?: readonly string[] | null;
}) {
  const attendeeIds = (input.attendeeIds ?? []).map(clean).filter(
    (value): value is string => value !== null,
  );
  const soleAttendeeId = attendeeIds.length === 1 ? attendeeIds[0] : null;
  const qrImageUrl = soleAttendeeId
    ? `${REGISTRATION_MANAGE_API_SENTINEL}/attendee-passes/${encodeURIComponent(soleAttendeeId)}/qr?format=png`
    : null;
  return {
    checkin_qr_url: REGISTRATION_MANAGE_LINK_SENTINEL,
    checkin_qr_image: qrImageUrl ?? "",
    checkin_block: buildCheckinBlock({
      confirmationCode: input.confirmationCode,
      passUrl: REGISTRATION_MANAGE_LINK_SENTINEL,
      qrImageUrl,
      attendeeCount: attendeeIds.length,
    }),
  };
}

export function buildCheckinBlock(input: CheckinBlockInput) {
  const passUrl = clean(input.passUrl);
  const qrImageUrl = clean(input.qrImageUrl);
  const code = clean(input.confirmationCode);
  if (!passUrl && !qrImageUrl && !code) return "";
  const isParty = (input.attendeeCount ?? 0) > 1;

  const lines = ["### At check-in", ""];
  if (qrImageUrl && !isParty) {
    lines.push(
      "Show this QR code at the check-in desk:",
      "",
      `![Check-in QR code](${qrImageUrl})`,
      "",
    );
  } else if (passUrl) {
    lines.push(
      isParty
        ? "Everyone on this registration has their own check-in code. Open your registration to show each attendee's code at the desk:"
        : "Open your registration to show your check-in QR code at the desk:",
      "",
      `[${isParty ? "Show our check-in passes" : "Show my check-in pass"}](${passUrl})`,
      "",
    );
  }
  if (code) {
    const codes = isParty ? "the codes" : "the code";
    lines.push(
      qrImageUrl || passUrl
        ? `If you cannot open ${codes}, give your confirmation code **${code}** at the desk instead.`
        : `Give your confirmation code **${code}** at the check-in desk.`,
    );
  }
  return lines.join("\n").trimEnd();
}
