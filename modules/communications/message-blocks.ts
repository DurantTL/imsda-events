import {
  REGISTRATION_MANAGE_API_SENTINEL,
  REGISTRATION_MANAGE_LINK_SENTINEL,
} from "@/modules/communications/manage-link";
import { escapeMarkdown } from "@/modules/communications/email-html";
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
  | "ORGANIZATION_INVOICED"
  /** A "Group" registration (#650): no card online, billed to its contact after the event. */
  | "GROUP_INVOICED";

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
  /**
   * The per-person price sentence for a deferred-organization registration (#621), e.g.
   * "$25 per person. Your church is billed after the event." No total is ever printed there.
   */
  perPersonNotice?: string | null;
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
      `**${clean(input.perPersonNotice) ?? "Your church is billed after the event."}**`,
    ];
    if (organization) lines.push("", `Responsible organization: **${organization}**`);
    if (billingContact) lines.push(`Billing contact: **${billingContact}**`);
    return lines.join("\n");
  }

  if (input.state === "GROUP_INVOICED") {
    const lines = [
      "### Payment status",
      "",
      "**No payment is due online.** You'll be billed after the event.",
      "",
      `**Estimated total: ${total}**`,
    ];
    const notice = clean(input.perPersonNotice);
    if (notice) lines.push("", notice);
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
  /**
   * Each attendee's own pass QR, labelled with their name. When present for a
   * party, these replace the portal-link fallback: every code is shown next to
   * the person it checks in, so nobody is handed someone else's.
   */
  attendeeQrs?: readonly AttendeeQr[] | null;
};

export type AttendeeQr = { name: string; qrImageUrl: string };

/** One labelled QR image per attendee. Names are registrant-supplied, so escaped. */
export function buildAttendeeQrImagesBlock(attendeeQrs: readonly AttendeeQr[]) {
  return attendeeQrs
    .map((attendee, index) => {
      const name = escapeMarkdown(clean(attendee.name) ?? `Attendee ${index + 1}`);
      return [`**${name}**`, "", `![Check-in QR code for ${name}](${attendee.qrImageUrl})`].join("\n");
    })
    .join("\n\n");
}

function attendeePassQrUrl(attendeeId: string) {
  return `${REGISTRATION_MANAGE_API_SENTINEL}/attendee-passes/${encodeURIComponent(attendeeId)}/qr?format=png`;
}

const CHECKIN_QR_IMAGE_MARKDOWN = /!\[[^\]]*\]\(\s*\{\{\s*checkin_qr_image\s*\}\}\s*\)/g;

/**
 * A single image token cannot hold several pictures, so for a party that gets
 * per-attendee QRs the template's `![…]({{checkin_qr_image}})` is swapped for
 * the labelled per-attendee block before rendering.
 */
export function withPerAttendeeQrImages(body: string, attendeeCount: number) {
  if (attendeeCount > MAX_INLINE_ATTENDEE_QRS) {
    // Too many pictures for one email: link to the portal, which shows every pass.
    return body.replace(CHECKIN_QR_IMAGE_MARKDOWN, "[Show our check-in passes]({{checkin_qr_url}})");
  }
  return attendeeCount > 1
    ? body.replace(CHECKIN_QR_IMAGE_MARKDOWN, "{{checkin_qr_images}}")
    : body;
}

/** Above this many attendees an announcement links to the portal instead of inlining every QR. */
export const MAX_INLINE_ATTENDEE_QRS = 8;

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
  /**
   * Event announcements only: name every attendee's own pass QR. A party then
   * gets one labelled code each rather than the portal link.
   */
  attendees?: ReadonlyArray<{ id: string; name: string }> | null;
}) {
  const attendeeQrs = (input.attendees ?? [])
    .filter((attendee) => clean(attendee.id))
    .map((attendee) => ({
      name: attendee.name,
      qrImageUrl: attendeePassQrUrl(attendee.id),
    }));
  const attendeeIds = (input.attendeeIds ?? []).map(clean).filter(
    (value): value is string => value !== null,
  );
  const soleAttendeeId = attendeeIds.length === 1 ? attendeeIds[0] : null;
  const qrImageUrl = soleAttendeeId ? attendeePassQrUrl(soleAttendeeId) : null;
  const inlineQrs = attendeeQrs.length <= MAX_INLINE_ATTENDEE_QRS ? attendeeQrs : [];
  const perAttendee = inlineQrs.length > 1 ? inlineQrs : null;
  return {
    checkin_qr_url: REGISTRATION_MANAGE_LINK_SENTINEL,
    checkin_qr_image: qrImageUrl ?? "",
    checkin_qr_images: inlineQrs.length > 0 ? buildAttendeeQrImagesBlock(inlineQrs) : "",
    checkin_block: buildCheckinBlock({
      confirmationCode: input.confirmationCode,
      passUrl: REGISTRATION_MANAGE_LINK_SENTINEL,
      qrImageUrl,
      attendeeCount: attendeeIds.length,
      attendeeQrs: perAttendee,
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
  if (isParty && input.attendeeQrs && input.attendeeQrs.length > 1) {
    lines.push(
      "Everyone on this registration has their own check-in QR code. Show each person's code at the check-in desk:",
      "",
      buildAttendeeQrImagesBlock(input.attendeeQrs),
      "",
    );
    if (passUrl) lines.push(`[Show our check-in passes](${passUrl})`, "");
    if (code) {
      lines.push(`If you cannot open the codes, give your confirmation code **${code}** at the desk instead.`);
    }
    return lines.join("\n").trimEnd();
  }
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

export type SeminarAttendee = {
  name: string;
  /** Every seminar field the form has, with this attendee's choices in ranked order. */
  fields: ReadonlyArray<{ label: string; choices: readonly string[]; assigned: readonly string[] }>;
};

function ordinal(position: number) {
  const mod100 = position % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${position}th`;
  const suffix = ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[position % 10] ?? "th";
  return `${position}${suffix}`;
}

/**
 * Markdown list of each attendee's seminar choices in ranked order, with their
 * assigned seminar first where one exists. Names and option labels come from
 * registrants and staff, so every one is escaped. Returns "" when the form has
 * no seminar choice at all, so the section is omitted rather than empty.
 */
export function buildSeminarPreferencesBlock(attendees: readonly SeminarAttendee[]) {
  return attendees
    .map((attendee, index) => {
      // Fields with nothing to say are left out, and so are attendees with none.
      const fields = attendee.fields.filter((field) => field.choices.length > 0 || field.assigned.length > 0);
      if (fields.length === 0) return null;
      const lines = [`**${escapeMarkdown(clean(attendee.name) ?? `Attendee ${index + 1}`)}**`];
      const labelled = fields.length > 1;
      for (const field of fields) {
        const prefix = labelled ? `${escapeMarkdown(field.label)} — ` : "";
        field.assigned.forEach((value) => lines.push(`- ${prefix}Assigned: ${escapeMarkdown(value)}`));
        field.choices.forEach((choice, rank) => (
          lines.push(`- ${prefix}${ordinal(rank + 1)} choice: ${escapeMarkdown(choice)}`)
        ));
      }
      return lines.join("\n");
    })
    .filter((block): block is string => block !== null)
    .join("\n\n");
}
