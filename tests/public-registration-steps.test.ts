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
  it("keeps a simple RSVP section linked to one step and adds a review", () => {
    const definition = template("simple_rsvp");
    const steps = getPublicRegistrationStepPlan(
      definition,
      new Set(definition.sections.flatMap((section) => section.fields.map((field) => field.key))),
    );

    expect(steps.map((step) => step.id)).toEqual(["section_contact", "__review"]);
    expect(steps[0]).toMatchObject({
      shortLabel: "Your information",
      title: "Your information",
      sectionId: "section_contact",
      fieldKeys: ["first_name", "last_name", "email"],
      managesAttendees: true,
    });
  });

  it("uses the retreat sections as editable steps and keeps payment final", () => {
    const definition = template("womens_retreat_export");
    const steps = getPublicRegistrationStepPlan(
      definition,
      new Set(definition.sections.flatMap((section) => section.fields.map((field) => field.key))),
    );

    expect(steps.map((step) => step.id)).toEqual([
      "wr_contact",
      "wr_attendee",
      "wr_payment",
    ]);
    expect(steps.find((step) => step.id === "wr_attendee")?.fieldKeys).toEqual(
      expect.arrayContaining([
        "meal_preference",
        "session_1_preferences",
        "session_2_preferences",
        "session_3_preferences",
      ]),
    );
    expect(steps.find((step) => step.id === "wr_payment")).toMatchObject({
      shortLabel: "Payment",
      isReview: true,
      fieldKeys: expect.arrayContaining(["payment_method", "promo_code", "acknowledgment"]),
    });
  });

  it("keeps mixed fields together instead of repeating their section", () => {
    const definition = template("retreat_registration");
    const steps = getPublicRegistrationStepPlan(
      definition,
      new Set(definition.sections.flatMap((section) => section.fields.map((field) => field.key))),
    );

    expect(steps.map((step) => step.id)).toEqual([
      "section_attendee",
      "section_contact",
      "__review",
    ]);
    expect(steps.find((step) => step.id === "section_contact")?.fieldKeys).toEqual([
      "email",
      "phone",
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
    expect(steps.at(-1)?.isReview).toBe(true);
  });

  it("uses section copy for step copy without duplicating field assignments", () => {
    const source = structuredClone(template("simple_rsvp"));
    source.sections[0].title = "Registrant details";
    source.sections[0].description = "Contact information for this reservation.";
    source.sections[0].stepLabel = "Details";
    const steps = getPublicRegistrationStepPlan(source);

    expect(steps[0]).toMatchObject({
      shortLabel: "Details",
      title: "Registrant details",
      description: "Contact information for this reservation.",
    });
    expect(steps.flatMap((step) => step.fieldKeys)).toHaveLength(
      new Set(steps.flatMap((step) => step.fieldKeys)).size,
    );
  });

  it("formats ranked choices and acknowledgements for review", () => {
    expect(formatPublicRegistrationAnswer(["Seminar A", "Seminar C"])).toBe(
      "Seminar A → Seminar C",
    );
    expect(formatPublicRegistrationAnswer(true)).toBe("Accepted");
    expect(formatPublicRegistrationAnswer("   ")).toBeNull();
  });
});
