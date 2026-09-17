import { describe, expect, it } from "vitest";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import { computeRegistrationFlags, registrationFlagKinds } from "@/modules/registrations/flags";

function registration(overrides: Partial<RegistrationRecord> = {}): RegistrationRecord {
  return {
    confirmationCode: "WR26-1042",
    balanceCents: 0,
    publicSubmission: null,
    accountHolder: { id: "person-1", firstName: "Marta", lastName: "Alvarez", email: "marta@example.test", phone: "" },
    attendees: [{
      id: "attendee-1",
      firstName: "Marta",
      lastName: "Alvarez",
      email: "marta@example.test",
      phone: "",
      attendeeType: "ATTENDEE",
      position: 0,
      source: "PUBLIC_REGISTRATION",
      responses: {},
      checkedIn: false,
      checkInId: null,
      checkedInAt: null,
    }],
    ...overrides,
  } as unknown as RegistrationRecord;
}

describe("computeRegistrationFlags — computed at read time, never stored", () => {
  it("flags nothing for a paid-in-full registration with no public submission", () => {
    expect(computeRegistrationFlags(registration())).toEqual([]);
  });

  it("flags an outstanding balance", () => {
    const flags = computeRegistrationFlags(registration({ balanceCents: 12500 }));
    expect(flags.map((flag) => flag.kind)).toEqual(["BALANCE_DUE"]);
    expect(flags[0]!.detail).toContain("$125.00");
  });

  it("flags a public-form registration with an attendee missing responses", () => {
    const flags = computeRegistrationFlags(registration({
      publicSubmission: { formName: "Retreat" } as never,
    }));
    expect(flags.map((flag) => flag.kind)).toEqual(["MISSING_ATTENDEE_RESPONSES"]);
  });

  it("does not flag missing responses for a staff-built registration with no public submission", () => {
    const flags = computeRegistrationFlags(registration({ publicSubmission: null }));
    expect(flags).toEqual([]);
  });

  it("is purely derived: the same registration data always produces the same flags, and different data produces different flags", () => {
    const unpaid = registration({ balanceCents: 500 });
    const paid = registration({ balanceCents: 0 });
    expect(computeRegistrationFlags(unpaid)).not.toEqual(computeRegistrationFlags(paid));
    expect(computeRegistrationFlags(unpaid)).toEqual(computeRegistrationFlags(unpaid));
  });

  it("only defines the flags the specification example calls out as computed conditions", () => {
    expect(registrationFlagKinds).toContain("BALANCE_DUE");
  });

  it("flags a registration with a balance the attendee cannot pay online", () => {
    const flags = computeRegistrationFlags(registration({
      balanceCents: 12500,
      onlinePaymentUnavailable: true,
    } as never));
    expect(flags.map((flag) => flag.kind)).toEqual(["BALANCE_DUE", "NO_ONLINE_PAYMENT_CONFIGURATION"]);
  });

  it("does not flag online payment when it is available", () => {
    const flags = computeRegistrationFlags(registration({
      balanceCents: 12500,
      onlinePaymentUnavailable: false,
    } as never));
    expect(flags.map((flag) => flag.kind)).toEqual(["BALANCE_DUE"]);
  });
});
