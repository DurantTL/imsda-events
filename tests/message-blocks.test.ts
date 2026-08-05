import { describe, expect, it } from "vitest";
import {
  buildCheckinBlock,
  buildHotelInformationBlock,
  buildPaymentStatusBlock,
  buildRegistrationCheckinTokens,
  resolvePaymentState,
} from "@/modules/communications/message-blocks";
import {
  REGISTRATION_MANAGE_API_SENTINEL,
  REGISTRATION_MANAGE_LINK_SENTINEL,
} from "@/modules/communications/manage-link";
import { renderEmailBodyHtml } from "@/modules/communications/email-html";

const womensRetreatLodging = {
  hotelName: "Holiday Inn Des Moines – Airport Conference Center",
  hotelBookingUrl: "https://events.example.test/hotel-booking",
  hotelPhone: "(515) 287-2400",
  hotelGroupName: "IA-MO Conference of Seventh-day Adventists Women's Retreat",
  hotelRate: "$120 per night plus tax",
  hotelInstructions: "Pro tip: share a room with a friend and split the cost.",
};

describe("hotel information block", () => {
  it("renders every configured lodging detail for an event that books rooms", () => {
    const block = buildHotelInformationBlock(womensRetreatLodging);

    expect(block).toContain("### Hotel reservations");
    expect(block).toContain("Holiday Inn Des Moines – Airport Conference Center");
    expect(block).toContain("[Book your room](https://events.example.test/hotel-booking)");
    expect(block).toContain("(515) 287-2400");
    expect(block).toContain("IA-MO Conference of Seventh-day Adventists Women's Retreat");
    expect(block).toContain("$120 per night plus tax");
    expect(block).toContain("share a room with a friend");
    expect(renderEmailBodyHtml(block)).toContain(
      '<a href="https://events.example.test/hotel-booking"',
    );
  });

  /**
   * The reason lodging is per-event rather than embedded in a shared template:
   * most events book no room block, and a hotel that follows them would be
   * wrong for every one of them.
   */
  it("renders nothing for an event with no hotel", () => {
    expect(buildHotelInformationBlock(null)).toBe("");
    expect(buildHotelInformationBlock({})).toBe("");
    expect(buildHotelInformationBlock({ hotelName: "   " })).toBe("");
    expect(buildHotelInformationBlock({ hotelPhone: "(515) 287-2400" })).toBe("");
  });

  it("includes only the details that are configured", () => {
    const block = buildHotelInformationBlock({ hotelName: "Lodge", hotelPhone: "555-0100" });
    expect(block).toContain("Lodge");
    expect(block).toContain("555-0100");
    expect(block).not.toContain("Group rate");
    expect(block).not.toContain("Reserve online");
  });

  it("refuses a booking URL that is not a web address and never breaks the link out", () => {
    const block = buildHotelInformationBlock({
      hotelName: "Bracket ] Hotel",
      hotelBookingUrl: "javascript:alert(1)",
    });
    expect(block).not.toContain("[Book your room]");
    expect(block).toContain("javascript:alert(1)");
    expect(renderEmailBodyHtml(block)).not.toContain('href="javascript:');
    // A bracket in the name cannot terminate the emphasis or a link around it.
    expect(block).toContain("**Bracket  Hotel**");
  });
});

describe("payment status block", () => {
  const base = { totalCents: 12_500, paidCents: 12_500, balanceCents: 0 };

  it("confirms payment for a registration with no balance", () => {
    const block = buildPaymentStatusBlock({ ...base, state: "PAID" });
    expect(block).toContain("Paid in full");
    expect(block).toContain("$125.00");
    expect(block).not.toContain("Pay your balance");
  });

  it("asks for payment, with instructions and a button, when a balance remains", () => {
    const block = buildPaymentStatusBlock({
      state: "BALANCE_DUE",
      totalCents: 12_500,
      paidCents: 5_000,
      balanceCents: 7_500,
      paymentInstructions: "Send a check to the conference office.",
      portalUrl: "https://events.example.test/manage/abc",
    });

    expect(block).toContain("### Balance due");
    expect(block).toContain("Balance due: **$75.00**");
    expect(block).toContain("Send a check to the conference office.");
    expect(block).toContain("[Pay your balance](https://events.example.test/manage/abc)");
  });

  it("never asks a complimentary registration for money", () => {
    const block = buildPaymentStatusBlock({
      state: "COMPLIMENTARY",
      totalCents: 0,
      paidCents: 0,
      balanceCents: 0,
      portalUrl: "https://events.example.test/manage/abc",
    });
    expect(block).toContain("complimentary");
    expect(block).not.toContain("Pay your balance");
    expect(block).not.toContain("Balance due");
  });

  it("tells a waitlisted registration its place and that nothing is charged", () => {
    const block = buildPaymentStatusBlock({
      state: "WAITLISTED",
      totalCents: 12_500,
      paidCents: 0,
      balanceCents: 12_500,
      waitlistPosition: 7,
      portalUrl: "https://events.example.test/manage/abc",
    });

    expect(block).toContain("number **7** on the waitlist");
    expect(block).toContain("No payment is due");
    expect(block).not.toContain("[Pay your balance]");
  });

  it("offers payment once a promotion gives the registration a place", () => {
    const block = buildPaymentStatusBlock({
      state: "WAITLIST_PROMOTED",
      totalCents: 12_500,
      paidCents: 0,
      balanceCents: 12_500,
      paymentInstructions: "Continue payment from your registration page.",
      portalUrl: "https://events.example.test/manage/abc",
    });

    expect(block).toContain("moved off the waitlist");
    expect(block).toContain("[Pay your balance](https://events.example.test/manage/abc)");
  });

  it("states cancellation facts without promising a refund", () => {
    const block = buildPaymentStatusBlock({
      state: "CANCELLED",
      totalCents: 12_500,
      paidCents: 12_500,
      balanceCents: 0,
      cancellationNote: "No additional refund was created by this cancellation.",
    });
    expect(block).toContain("No additional refund was created");
    expect(block).not.toContain("[Pay your balance]");
  });

  it("tells a deferred-organization registration its rate is not owed by the attendee", () => {
    const block = buildPaymentStatusBlock({
      state: "ORGANIZATION_INVOICED",
      totalCents: 900,
      paidCents: 0,
      balanceCents: 900,
      organization: "Ankeny Son-Seekers",
      billingContact: "Jane Doe",
    });

    expect(block).toContain("No payment is due online");
    expect(block).toContain("$9.00");
    expect(block).toContain("Responsible organization: **Ankeny Son-Seekers**");
    expect(block).toContain("Billing contact: **Jane Doe**");
    expect(block).not.toContain("Balance due");
    expect(block).not.toContain("[Pay your balance]");
  });

  it("omits organization and billing-contact lines when neither is known", () => {
    const block = buildPaymentStatusBlock({
      state: "ORGANIZATION_INVOICED",
      totalCents: 900,
      paidCents: 0,
      balanceCents: 900,
    });

    expect(block).not.toContain("Responsible organization");
    expect(block).not.toContain("Billing contact");
  });

  it("reads a zero total as complimentary rather than paid", () => {
    expect(resolvePaymentState({ totalCents: 0, balanceCents: 0 })).toBe("COMPLIMENTARY");
    expect(resolvePaymentState({ totalCents: 12_500, balanceCents: 0 })).toBe("PAID");
    expect(resolvePaymentState({ totalCents: 12_500, balanceCents: 500 })).toBe("BALANCE_DUE");
    expect(
      resolvePaymentState({ totalCents: 12_500, balanceCents: 500, isWaitlisted: true }),
    ).toBe("WAITLISTED");
    expect(
      resolvePaymentState({ totalCents: 12_500, balanceCents: 0, isCancelled: true }),
    ).toBe("CANCELLED");
  });
});

describe("check-in block", () => {
  it("inlines the QR only for a single-attendee registration", () => {
    const tokens = buildRegistrationCheckinTokens({
      confirmationCode: "REG-1234",
      attendeeIds: ["attendee-1"],
    });

    expect(tokens.checkin_qr_image).toBe(
      `${REGISTRATION_MANAGE_API_SENTINEL}/attendee-passes/attendee-1/qr?format=png`,
    );
    expect(tokens.checkin_qr_url).toBe(REGISTRATION_MANAGE_LINK_SENTINEL);
    expect(tokens.checkin_block).toContain("![Check-in QR code]");
    expect(tokens.checkin_block).toContain("REG-1234");
  });

  /**
   * A pass resolves one attendee. Inlining the first person's code for a family
   * would check that person in and leave everyone else holding a code that is
   * not theirs, so a party is sent to the portal, where each attendee has their
   * own labelled pass.
   */
  it("never inlines one attendee's code for a multi-attendee registration", () => {
    const tokens = buildRegistrationCheckinTokens({
      confirmationCode: "REG-1234",
      attendeeIds: ["attendee-1", "attendee-2", "attendee-3"],
    });

    expect(tokens.checkin_qr_image).toBe("");
    expect(tokens.checkin_block).not.toContain("![");
    expect(tokens.checkin_block).not.toContain("attendee-1");
    expect(tokens.checkin_block).toContain("own check-in code");
    expect(tokens.checkin_block).toContain("[Show our check-in passes]");
    expect(tokens.checkin_block).toContain("**REG-1234**");
  });

  it("falls back to the portal link and the code when no attendee exists", () => {
    const tokens = buildRegistrationCheckinTokens({
      confirmationCode: "REG-1234",
      attendeeIds: [],
    });

    expect(tokens.checkin_qr_image).toBe("");
    expect(tokens.checkin_block).not.toContain("![");
    expect(tokens.checkin_block).toContain("[Show my check-in pass]");
    expect(tokens.checkin_block).toContain("**REG-1234**");
  });

  it("renders nothing when there is neither a pass nor a code", () => {
    expect(buildCheckinBlock({ confirmationCode: "" })).toBe("");
  });
});
