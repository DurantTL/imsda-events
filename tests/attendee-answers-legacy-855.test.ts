import { describe, expect, it } from "vitest";
import { prepareTieredAttendeeAnswerUpdate } from "@/modules/attendee-accounts/registration-answer-policy";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

const definition = registrationFormDefinitionSchema.parse({
  title: "Legacy fixture",
  description: "Fictitious.",
  confirmationMessage: "Done.",
  sections: [{
    id: "choices_section",
    title: "Choices",
    description: "",
    fields: [
      { id: "f_meal", key: "meal", label: "Meal choice", helpText: "", type: "SELECT", scope: "ATTENDEE", required: false, options: ["Standard", "Vegetarian"] },
      { id: "f_extra", key: "extra_tickets", label: "Extra tickets", helpText: "", type: "NUMBER", scope: "ATTENDEE", required: false, options: [] },
    ],
  }],
});

const base = { definition, policy: "TIERED" as const, registrationResponses: {}, currentResponses: { meal: "Standard", extra_tickets: "lots" } };

describe("attendee self-service answers and old invalid values (#855)", () => {
  it("saves a change to another field when an old invalid number is left alone", () => {
    const result = prepareTieredAttendeeAnswerUpdate({ ...base, changes: { meal: "Vegetarian", extra_tickets: "lots" } });
    expect(result.responses.meal).toBe("Vegetarian");
    expect(result.responses.extra_tickets).toBe("lots");
    expect(() => prepareTieredAttendeeAnswerUpdate({ ...base, changes: { meal: "Vegetarian" } })).not.toThrow();
  });

  it("still rejects a new invalid number without echoing it", () => {
    let message = "";
    try {
      prepareTieredAttendeeAnswerUpdate({ ...base, changes: { extra_tickets: "many" } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Extra tickets must be a number/);
    expect(message).not.toContain("many");
  });
});
