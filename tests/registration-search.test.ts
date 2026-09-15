import { describe, expect, it } from "vitest";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import {
  attendeeSummaryLabel,
  registrationMatchesSearch,
  registrationSearchTerms,
} from "@/modules/registrations/search";

function registration(
  overrides: Partial<RegistrationRecord> = {},
): RegistrationRecord {
  return {
    confirmationCode: "WR26-1042",
    accountHolder: {
      id: "person-1",
      firstName: "Marta",
      lastName: "Alvarez",
      email: "marta.alvarez@example.test",
      phone: "",
    },
    attendees: [{
      id: "attendee-1",
      firstName: "Marta",
      lastName: "Alvarez",
      email: "marta.alvarez@example.test",
      phone: "",
      attendeeType: "ATTENDEE",
      position: 0,
      source: "PUBLIC_REGISTRATION",
      responses: {},
      checkedIn: false,
      checkInId: null,
      checkedInAt: null,
    }, {
      id: "attendee-2",
      firstName: "Rosalind",
      lastName: "Nkemdirim",
      email: "rosalind.n@example.test",
      phone: "",
      attendeeType: "ATTENDEE",
      position: 1,
      source: "PUBLIC_REGISTRATION",
      responses: {},
      checkedIn: false,
      checkInId: null,
      checkedInAt: null,
    }],
    ...overrides,
  } as unknown as RegistrationRecord;
}

describe("registration search", () => {
  it("finds a registration by an attendee who is not the account holder", () => {
    expect(registrationMatchesSearch(registration(), "Rosalind")).toBe(true);
    expect(registrationMatchesSearch(registration(), "rosalind.n@example.test")).toBe(true);
  });

  it("still finds a registration by payer name and confirmation code", () => {
    expect(registrationMatchesSearch(registration(), "alvarez")).toBe(true);
    expect(registrationMatchesSearch(registration(), "wr26-1042")).toBe(true);
  });

  it("treats an empty query as no filter and rejects an unrelated term", () => {
    expect(registrationMatchesSearch(registration(), "   ")).toBe(true);
    expect(registrationMatchesSearch(registration(), "Kowalski")).toBe(false);
  });

  it("drops blank contact fields from the searchable terms", () => {
    expect(registrationSearchTerms(registration())).not.toContain("");
  });

  it("summarizes attendee names and counts the remainder", () => {
    expect(attendeeSummaryLabel(registration())).toBe("Marta Alvarez, Rosalind Nkemdirim");
    expect(attendeeSummaryLabel(registration(), 1)).toBe("Marta Alvarez +1 more");
    expect(attendeeSummaryLabel(registration({ attendees: [] }))).toBe("");
  });
});
