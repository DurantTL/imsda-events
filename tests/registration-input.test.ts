import { describe, expect, it } from "vitest";
import { attendeeInputSchema, registrationInputSchema, registrationUpdateSchema } from "@/modules/registrations/schemas";

describe("registration input validation", () => {
  it("normalizes a valid registration payload", () => {
    const result = registrationInputSchema.parse({
      firstName: "  Alicia ",
      lastName: " Smith  ",
      email: " ALICIA@EXAMPLE.TEST ",
      phone: " 555-0101 ",
      attendeeType: "ATTENDEE",
      status: "SUBMITTED",
      totalAmountCents: 17500,
    });

    expect(result).toMatchObject({
      firstName: "Alicia",
      lastName: "Smith",
      email: "alicia@example.test",
      phone: "555-0101",
    });
  });

  it("rejects invalid money and contact values", () => {
    expect(() => registrationInputSchema.parse({
      firstName: "Test",
      lastName: "Person",
      email: "not-an-email",
      totalAmountCents: -1,
    })).toThrow();
  });

  it("requires at least one field for an edit", () => {
    expect(() => registrationUpdateSchema.parse({})).toThrow();
    expect(() => registrationUpdateSchema.parse({ status: "CONFIRMED" })).toThrow();
    expect(() => registrationUpdateSchema.parse({ phone: "555-0199", status: "CANCELLED" })).toThrow();
    expect(registrationUpdateSchema.parse({ phone: " 555-0199 " })).toEqual({ phone: "555-0199" });
  });

  it("validates an attendee added to a party", () => {
    expect(attendeeInputSchema.parse({ firstName: "Avery", lastName: "Miller" })).toMatchObject({
      firstName: "Avery",
      lastName: "Miller",
      attendeeType: "ATTENDEE",
    });
  });
});
