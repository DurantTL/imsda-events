import { describe, expect, it } from "vitest";
import { createOpaqueToken } from "@/modules/access/tokens";
import {
  defaultRegistrationAccessExpiry,
  describePublicRegistrationStatus,
  isRegistrationAccessToken,
  publicAttendeeName,
  publicContactFromSnapshot,
  publicContactUpdateSchema,
  summarizePublicPayment,
} from "@/modules/public-access/domain";

describe("private registration access domain", () => {
  it("recognizes only the 256-bit base64url bearer-token shape", () => {
    const token = createOpaqueToken();
    expect(token).toHaveLength(43);
    expect(isRegistrationAccessToken(token)).toBe(true);
    expect(isRegistrationAccessToken(`${token}=`)).toBe(false);
    expect(isRegistrationAccessToken("short-token")).toBe(false);
    expect(isRegistrationAccessToken(`${"a".repeat(42)}!`)).toBe(false);
  });

  it("keeps a link active through at least 30 days after the event", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    expect(defaultRegistrationAccessExpiry(
      now,
      new Date("2026-10-11T18:00:00.000Z"),
    ).toISOString()).toBe("2026-11-10T18:00:00.000Z");

    expect(defaultRegistrationAccessExpiry(
      now,
      new Date("2026-07-20T18:00:00.000Z"),
    ).toISOString()).toBe("2026-08-22T12:00:00.000Z");
  });

  it("allows only normalized contact details through the public update schema", () => {
    expect(publicContactUpdateSchema.parse({
      firstName: "  Caleb ",
      lastName: " Durant ",
      email: " CALEB@EXAMPLE.TEST ",
      phone: " 555-0101 ",
    })).toEqual({
      firstName: "Caleb",
      lastName: "Durant",
      email: "caleb@example.test",
      phone: "555-0101",
    });

    expect(publicContactUpdateSchema.safeParse({
      firstName: "Caleb",
      lastName: "Durant",
      email: "caleb@example.test",
      phone: "",
      status: "CONFIRMED",
    }).success).toBe(false);
    expect(publicContactUpdateSchema.safeParse({
      firstName: "Caleb",
      lastName: "Durant",
      email: "caleb@example.test",
      phone: "",
      totalAmountCents: 0,
    }).success).toBe(false);
    expect(publicContactUpdateSchema.safeParse({
      firstName: "Caleb",
      lastName: "Durant",
      email: "caleb@example.test",
      phone: "",
      responses: {},
    }).success).toBe(false);
  });

  it("describes submitted, confirmed, waitlisted, and cancelled states without overstating them", () => {
    expect(describePublicRegistrationStatus("SUBMITTED", null)).toMatchObject({
      label: "Submitted",
      detail: expect.stringContaining("awaiting final confirmation"),
      tone: "neutral",
    });
    expect(describePublicRegistrationStatus("CONFIRMED", null)).toMatchObject({
      label: "Confirmed",
      tone: "positive",
    });
    expect(describePublicRegistrationStatus("WAITLISTED", 4)).toMatchObject({
      label: "Waitlisted · position 4",
      detail: expect.stringContaining("not confirmed"),
      tone: "waiting",
    });
    expect(describePublicRegistrationStatus("CANCELLED", null)).toMatchObject({
      label: "Cancelled",
      tone: "cancelled",
    });
  });

  it("never makes a waitlisted or cancelled registration payable", () => {
    expect(summarizePublicPayment({
      status: "WAITLISTED",
      totalCents: 25_000,
      payments: [],
    })).toMatchObject({
      state: "NOT_DUE",
      totalCents: 25_000,
      amountDueCents: 0,
      paymentEligible: false,
      label: "No payment due while waitlisted",
    });

    expect(summarizePublicPayment({
      status: "CANCELLED",
      totalCents: 25_000,
      payments: [{ amountCents: 25_000, refundedCents: 10_000 }],
    })).toMatchObject({
      state: "NOT_DUE",
      paidCents: 15_000,
      refundedCents: 10_000,
      amountDueCents: 0,
      paymentEligible: false,
    });
  });

  it("reports successful payments net of succeeded refunds", () => {
    expect(summarizePublicPayment({
      status: "CONFIRMED",
      totalCents: 25_000,
      payments: [
        { amountCents: 10_000, refundedCents: 2_500 },
        { amountCents: 5_000, refundedCents: 0 },
      ],
    })).toMatchObject({
      state: "PARTIALLY_PAID",
      paidCents: 12_500,
      refundedCents: 2_500,
      amountDueCents: 12_500,
      paymentEligible: true,
    });

    expect(summarizePublicPayment({
      status: "CONFIRMED",
      totalCents: 25_000,
      payments: [{ amountCents: 25_000, refundedCents: 0 }],
    })).toMatchObject({
      state: "PAID",
      amountDueCents: 0,
      paymentEligible: false,
    });
  });

  it("uses registration-scoped contact and attendee snapshots with safe fallbacks", () => {
    expect(publicContactFromSnapshot(
      {
        firstName: "Registration",
        lastName: "Contact",
        email: "registration@example.test",
        phone: "",
      },
      {
        firstName: "Shared",
        lastName: "Person",
        email: "shared@example.test",
        phone: "555-0199",
      },
    )).toEqual({
      firstName: "Registration",
      lastName: "Contact",
      email: "registration@example.test",
      phone: "",
    });

    expect(publicContactFromSnapshot({}, {
      firstName: "Shared",
      lastName: "Person",
      email: "shared@example.test",
      phone: "555-0199",
    })).toEqual({
      firstName: "Shared",
      lastName: "Person",
      email: "shared@example.test",
      phone: "555-0199",
    });

    expect(publicAttendeeName(
      { firstName: "Original", lastName: "Attendee" },
      { firstName: "Updated", lastName: "Person" },
    )).toBe("Original Attendee");
  });
});
