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
  | "CANCELLED";

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
  /** Where the registrant can open their own check-in pass. */
  passUrl?: string | null;
  /** Direct image URL for the pass QR code. Omitted when unavailable. */
  qrImageUrl?: string | null;
};

/**
 * The check-in tokens for one registration, written against the delivery
 * sentinels so the private token only ever exists inside a sent message.
 *
 * `primaryAttendeeId` is the first attendee on the registration: a party shares
 * one confirmation and arrives together, and a body carrying one code per
 * attendee would be unreadable. Without one there is no pass to show, so the
 * image is omitted and the block falls back to the portal link.
 */
export function buildRegistrationCheckinTokens(input: {
  confirmationCode: string;
  primaryAttendeeId?: string | null;
}) {
  const attendeeId = clean(input.primaryAttendeeId);
  const qrImageUrl = attendeeId
    ? `${REGISTRATION_MANAGE_API_SENTINEL}/attendee-passes/${encodeURIComponent(attendeeId)}/qr?format=png`
    : null;
  return {
    checkin_qr_url: REGISTRATION_MANAGE_LINK_SENTINEL,
    checkin_qr_image: qrImageUrl ?? "",
    checkin_block: buildCheckinBlock({
      confirmationCode: input.confirmationCode,
      passUrl: REGISTRATION_MANAGE_LINK_SENTINEL,
      qrImageUrl,
    }),
  };
}

export function buildCheckinBlock(input: CheckinBlockInput) {
  const passUrl = clean(input.passUrl);
  const qrImageUrl = clean(input.qrImageUrl);
  const code = clean(input.confirmationCode);
  if (!passUrl && !qrImageUrl && !code) return "";

  const lines = ["### At check-in", ""];
  if (qrImageUrl) {
    lines.push(
      "Show this QR code at the check-in desk:",
      "",
      `![Check-in QR code](${qrImageUrl})`,
      "",
    );
  } else if (passUrl) {
    lines.push("Open your registration to show your check-in QR code at the desk:", "", `[Show my check-in pass](${passUrl})`, "");
  }
  if (code) {
    lines.push(
      qrImageUrl || passUrl
        ? `If you cannot open the code, give your confirmation code **${code}** at the desk instead.`
        : `Give your confirmation code **${code}** at the check-in desk.`,
    );
  }
  return lines.join("\n").trimEnd();
}
