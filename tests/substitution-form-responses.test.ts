import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { substitutedFormResponses } from "@/modules/registrations/operations-domain";

describe("an attendee's answers after a substitution (WR26)", () => {
  it("moves the name, email, and phone answers to the replacement and keeps the rest", () => {
    expect(substitutedFormResponses(
      {
        first_name: "Avery",
        last_name: "Guest",
        attendee_name: "Avery Guest",
        attendee_email: "avery@example.test",
        attendee_phone: "555-0100",
        meal: "Vegetarian",
        seminar_preferences: ["Prayer", "Service"],
      },
      { firstName: "Riley", lastName: "Guest", email: "", phone: "555-0199" },
    )).toEqual({
      first_name: "Riley",
      last_name: "Guest",
      attendee_name: "Riley Guest",
      attendee_email: "",
      attendee_phone: "555-0199",
      meal: "Vegetarian",
      seminar_preferences: ["Prayer", "Service"],
    });
  });

  it("doesn't add answers the attendee never had, or touch the registration contact", () => {
    expect(substitutedFormResponses(
      { primary_contact_name: "Taylor Contact", meal: "Vegan" },
      { firstName: "Riley", lastName: "Guest" },
    )).toEqual({ primary_contact_name: "Taylor Contact", meal: "Vegan" });
  });
});
