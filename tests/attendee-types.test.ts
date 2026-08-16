import { describe, expect, it } from "vitest";
import {
  ageOnEventDate,
  attendeeTypeReference,
  attendeeTypeUpdateSchema,
  isWithinAgeBand,
  planAttendeeTypeBackfill,
} from "@/modules/attendee-types/domain";
import { stripAttendeeTypeOptions, withAttendeeTypeOptions, withAttendeeTypeOptionsForAttendee } from "@/modules/attendee-types/form-options";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

const configuredTypes = [
  { id: "type-adult", code: "ADULT", label: "Adult", description: "", sortOrder: 1, isActive: true, minimumAge: 18, maximumAge: null },
  { id: "type-youth", code: "YOUTH", label: "Youth", description: "School-age participant", sortOrder: 2, isActive: true, minimumAge: 10, maximumAge: 17 },
];

const sourcedDefinition = registrationFormDefinitionSchema.parse({
  title: "Synthetic retreat registration",
  description: "",
  confirmationMessage: "Registration received.",
  sections: [{
    id: "attendee-section",
    title: "Attendee details",
    description: "",
    fields: [{
      id: "attendee-type-field",
      key: "attendee_type",
      label: "Attendee type",
      helpText: "",
      type: "RADIO",
      scope: "ATTENDEE",
      required: true,
      options: [],
      optionSource: "ATTENDEE_TYPES",
    }],
  }],
});

describe("attendee type reference contract", () => {
  it("keeps the historical snapshot when the configured label is renamed", () => {
    const reference = attendeeTypeReference({
      attendeeType: "Adult",
      attendeeTypeDefinition: { id: "type-adult", code: "ADULT", minimumAge: 18, maximumAge: null },
    });
    expect(reference).toEqual({
      id: "type-adult",
      code: "ADULT",
      labelSnapshot: "Adult",
      ageBand: { minimumAge: 18, maximumAge: null },
    });
    const futureForm = withAttendeeTypeOptions(sourcedDefinition, [{ ...configuredTypes[0]!, label: "Adult attendee" }]);
    expect(futureForm.sections[0]!.fields[0]!.optionLabels?.ADULT).toBe("Adult attendee");
    expect(reference.labelSnapshot).toBe("Adult");
  });

  it("removes a deactivated type from future choices without invalidating existing references", () => {
    const reference = attendeeTypeReference({
      attendeeType: "Youth",
      attendeeTypeDefinition: { id: "type-youth", code: "YOUTH", minimumAge: 10, maximumAge: 17 },
    });
    const futureForm = withAttendeeTypeOptions(sourcedDefinition, configuredTypes.map((type) => (
      type.id === "type-youth" ? { ...type, isActive: false } : type
    )));
    expect(futureForm.sections[0]!.fields[0]!.options).toEqual(["ADULT"]);
    expect(reference.id).toBe("type-youth");
    expect(reference.labelSnapshot).toBe("Youth");
  });

  it("evaluates inclusive age bands on the event date", () => {
    const birthDate = new Date("2010-08-10T00:00:00Z");
    expect(ageOnEventDate(birthDate, new Date("2028-08-09T00:00:00Z"))).toBe(17);
    expect(ageOnEventDate(birthDate, new Date("2028-08-10T00:00:00Z"))).toBe(18);
    expect(isWithinAgeBand(birthDate, new Date("2028-08-09T00:00:00Z"), { minimumAge: 10, maximumAge: 17 })).toBe(true);
    expect(isWithinAgeBand(birthDate, new Date("2028-08-10T00:00:00Z"), { minimumAge: 10, maximumAge: 17 })).toBe(false);
  });

  it("reports unmappable and ambiguous legacy values without guessing", () => {
    const rows = planAttendeeTypeBackfill(
      [...configuredTypes, { ...configuredTypes[1]!, id: "type-teen", code: "TEEN", label: "Youth" }],
      [{ attendeeType: "Adult", count: 2 }, { attendeeType: "Visitor", count: 1 }, { attendeeType: "Youth", count: 3 }],
    );
    expect(rows.map((row) => [row.value, row.status, row.attendeeTypeId])).toEqual([
      ["Adult", "MAPPABLE", "type-adult"],
      ["Visitor", "UNMAPPABLE", null],
      ["Youth", "AMBIGUOUS", null],
    ]);
  });

  it("keeps rejecting minimumAge > maximumAge on update, without allowing code to change", () => {
    expect(() => attendeeTypeUpdateSchema.parse({
      label: "Adult",
      description: "",
      sortOrder: 1,
      isActive: true,
      minimumAge: 18,
      maximumAge: 12,
    })).toThrow(/Minimum age cannot exceed maximum age/);
    const parsed = attendeeTypeUpdateSchema.parse({
      label: "Adult",
      description: "",
      sortOrder: 1,
      isActive: true,
      minimumAge: 12,
      maximumAge: 18,
    });
    expect(parsed).not.toHaveProperty("code");
  });
});

describe("sourced form JSON persistence", () => {
  it("hydrates active selector options and scopes an inactive historical option", () => {
    const inactive = { ...configuredTypes[1]!, isActive: false };
    const hydrated = withAttendeeTypeOptionsForAttendee(sourcedDefinition, [configuredTypes[0]!, inactive], "YOUTH");
    expect(hydrated.sections[0]!.fields[0]!.options).toEqual(["ADULT", "YOUTH"]);
    const newAttendee = withAttendeeTypeOptionsForAttendee(sourcedDefinition, [configuredTypes[0]!, inactive]);
    expect(newAttendee.sections[0]!.fields[0]!.options).toEqual(["ADULT"]);
    expect(withAttendeeTypeOptions(sourcedDefinition, [configuredTypes[0]!, inactive]).sections[0]!.fields[0]!.options)
      .toEqual(["ADULT"]);
  });

  it("strips hydrated choices before a sourced field is written to storage", () => {
    const hydratedForPreview = withAttendeeTypeOptions(sourcedDefinition, configuredTypes);
    const hydratedField = hydratedForPreview.sections[0]!.fields[0]!;
    expect(hydratedField.options).toEqual(["ADULT", "YOUTH"]);
    expect(hydratedField.optionLabels?.ADULT).toBe("Adult");

    const readyToPersist = stripAttendeeTypeOptions(hydratedForPreview);
    const persistedField = readyToPersist.sections[0]!.fields[0]!;
    expect(persistedField.optionSource).toBe("ATTENDEE_TYPES");
    expect(persistedField.options).toEqual([]);
    expect(persistedField.optionLabels).toBeUndefined();
    expect(persistedField.optionDescriptions).toBeUndefined();
    expect(persistedField.choiceLimits).toBeUndefined();
    expect(persistedField.choicePricesCents).toBeUndefined();
    expect(persistedField.latePricing).toBeUndefined();
    expect(persistedField.availabilityMode).toBe("NONE");

    // Re-hydration from the stripped, source-driven JSON still works for display.
    const rehydrated = withAttendeeTypeOptions(readyToPersist, configuredTypes);
    expect(rehydrated.sections[0]!.fields[0]!.options).toEqual(["ADULT", "YOUTH"]);
  });

  it("leaves manually configured choice fields untouched", () => {
    const manualDefinition = registrationFormDefinitionSchema.parse({
      title: "Manual choices",
      description: "",
      confirmationMessage: "Received.",
      sections: [{
        id: "section",
        title: "Section",
        description: "",
        fields: [{
          id: "field-manual",
          key: "meal_preference",
          label: "Meal preference",
          helpText: "",
          type: "SELECT",
          scope: "ATTENDEE",
          required: true,
          options: ["Standard", "Vegetarian"],
        }],
      }],
    });
    const stripped = stripAttendeeTypeOptions(manualDefinition);
    expect(stripped.sections[0]!.fields[0]!.options).toEqual(["Standard", "Vegetarian"]);
  });

  it("treats an omitted attendee-type collection as no configured choices", () => {
    const hydrated = withAttendeeTypeOptions(sourcedDefinition, undefined);
    const field = hydrated.sections[0]!.fields[0]!;
    expect(field.options).toEqual([]);
    expect(field.optionLabels).toEqual({});
    expect(field.optionDescriptions).toEqual({});
  });
});

describe("required attendee-type selector consistency", () => {
  it("rejects a sourced field that is not required", () => {
    expect(() => registrationFormDefinitionSchema.parse({
      title: "Synthetic retreat registration",
      description: "",
      confirmationMessage: "Registration received.",
      sections: [{
        id: "attendee-section",
        title: "Attendee details",
        description: "",
        fields: [{
          id: "attendee-type-field",
          key: "attendee_type",
          label: "Attendee type",
          helpText: "",
          type: "RADIO",
          scope: "ATTENDEE",
          required: false,
          options: [],
          optionSource: "ATTENDEE_TYPES",
        }],
      }],
    })).toThrow(/attendee-type selector must be required/);
  });

  it("still rejects more than one attendee-type selector per form", () => {
    expect(() => registrationFormDefinitionSchema.parse({
      title: "Synthetic retreat registration",
      description: "",
      confirmationMessage: "Registration received.",
      sections: [{
        id: "attendee-section",
        title: "Attendee details",
        description: "",
        fields: [
          { id: "field-one", key: "attendee_type", label: "Attendee type", helpText: "", type: "RADIO", scope: "ATTENDEE", required: true, options: [], optionSource: "ATTENDEE_TYPES" },
          { id: "field-two", key: "registration_type", label: "Registration type", helpText: "", type: "RADIO", scope: "ATTENDEE", required: true, options: [], optionSource: "ATTENDEE_TYPES" },
        ],
      }],
    })).toThrow(/only one attendee-type selector/);
  });
});
