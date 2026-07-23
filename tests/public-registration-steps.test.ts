import { describe, expect, it } from "vitest";
import { formTemplates } from "@/modules/forms/definition";
import {
  formatPublicRegistrationAnswer,
  getPublicRegistrationStepPlan,
} from "@/modules/forms/public-registration-steps";

function template(key: string) {
  const match = formTemplates.find((candidate) => candidate.key === key);
  if (!match) throw new Error(`Missing form template: ${key}`);
  return match.definition;
}

describe("public registration step plan", () => {
  it("merges a simple RSVP into one details step and a review", () => {
    const definition = template("simple_rsvp");
    const steps = getPublicRegistrationStepPlan(
      definition,
      new Set(definition.sections.flatMap((section) => section.fields.map((field) => field.key))),
    );

    expect(steps.map((step) => step.id)).toEqual(["contact", "review"]);
    expect(steps[0]).toMatchObject({
      shortLabel: "Details",
      fieldKeys: ["email", "first_name", "last_name"],
    });
  });

  it("creates all four useful steps for a full retreat registration", () => {
    const definition = template("womens_retreat_export");
    const steps = getPublicRegistrationStepPlan(
      definition,
      new Set(definition.sections.flatMap((section) => section.fields.map((field) => field.key))),
    );

    expect(steps.map((step) => step.id)).toEqual([
      "contact",
      "attendees",
      "choices",
      "review",
    ]);
    expect(steps.find((step) => step.id === "choices")?.fieldKeys).toEqual(
      expect.arrayContaining([
        "meal_preference",
        "session_1_preferences",
        "session_2_preferences",
        "session_3_preferences",
      ]),
    );
    expect(steps.find((step) => step.id === "review")?.fieldKeys).toEqual(
      expect.arrayContaining(["registration_fee", "payment_method", "promo_code", "acknowledgment"]),
    );
  });

  it("separates contact fields from lodging in a mixed section", () => {
    const definition = template("retreat_registration");
    const steps = getPublicRegistrationStepPlan(
      definition,
      new Set(definition.sections.flatMap((section) => section.fields.map((field) => field.key))),
    );

    expect(steps.map((step) => step.id)).toEqual([
      "contact",
      "attendees",
      "choices",
      "review",
    ]);
    expect(steps.find((step) => step.id === "contact")?.fieldKeys).toEqual([
      "email",
      "phone",
    ]);
    expect(steps.find((step) => step.id === "choices")?.fieldKeys).toEqual([
      "lodging",
    ]);
  });

  it("omits conditional-only empty steps until their fields are visible", () => {
    const definition = template("spring_camporee_export");
    const visible = new Set(
      definition.sections
        .flatMap((section) => section.fields)
        .filter((field) => !field.conditional)
        .map((field) => field.key),
    );
    const steps = getPublicRegistrationStepPlan(definition, visible);

    expect(steps.every((step) => (
      step.fieldKeys.every((key) => visible.has(key))
    ))).toBe(true);
    expect(steps.at(-1)?.id).toBe("review");
  });

  it("formats ranked choices and acknowledgements for review", () => {
    expect(formatPublicRegistrationAnswer(["Seminar A", "Seminar C"])).toBe(
      "Seminar A → Seminar C",
    );
    expect(formatPublicRegistrationAnswer(true)).toBe("Accepted");
    expect(formatPublicRegistrationAnswer("   ")).toBeNull();
  });
});
