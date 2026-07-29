import { describe, expect, it } from "vitest";
import {
  AttendeeAnswerUpdateError,
  editableAttendeeFields,
  prepareTieredAttendeeAnswerUpdate,
} from "@/modules/attendee-accounts/registration-answer-policy";
import type { RegistrationFormDefinition } from "@/modules/forms/definition";

const definition: RegistrationFormDefinition = {
  title: "Retreat",
  description: "",
  confirmationMessage: "Registered",
  attendeeRoster: {
    enabled: true,
    minAttendees: 1,
    maxAttendees: 4,
    attendeeLabel: "Attendee",
    addButtonLabel: "Add attendee",
  },
  sections: [{
    id: "choices",
    title: "Choices",
    description: "",
    fields: [
      { id: "first", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
      { id: "type", key: "attendee_type", label: "Attendee type", helpText: "", type: "RADIO", scope: "ATTENDEE", required: true, options: ["Adult", "Worker"] },
      { id: "shirt", key: "shirt_size", label: "Shirt size", helpText: "", type: "SELECT", scope: "ATTENDEE", required: true, options: ["S", "M", "L"] },
      { id: "meal", key: "meal_preference", label: "Meal preference", helpText: "", type: "SELECT", scope: "ATTENDEE", required: true, options: ["Regular", "Vegetarian"] },
      { id: "diet", key: "dietary_needs", label: "Dietary needs / allergies", helpText: "", type: "LONG_TEXT", scope: "ATTENDEE", required: false, options: [] },
      { id: "age", key: "attendee_age", label: "Age", helpText: "", type: "NUMBER", scope: "ATTENDEE", required: false, options: [] },
      {
        id: "staff-session",
        key: "staff_session",
        label: "Staff session",
        helpText: "",
        type: "SELECT",
        scope: "ATTENDEE",
        required: false,
        options: ["Morning", "Afternoon"],
        conditional: { fieldKey: "attendee_type", operator: "EQUALS", value: "Worker" },
      },
      { id: "childcare", key: "childcare_needed", label: "Childcare needed?", helpText: "", type: "RADIO", scope: "ATTENDEE", required: false, options: ["No", "Yes"] },
      {
        id: "children",
        key: "childcare_children",
        label: "Number of children",
        helpText: "",
        type: "NUMBER",
        scope: "ATTENDEE",
        required: true,
        options: [],
        conditional: { fieldKey: "childcare_needed", operator: "EQUALS", value: "Yes" },
      },
      {
        id: "session",
        key: "session_preferences",
        label: "Rank two sessions",
        helpText: "",
        type: "RANKED_CHOICE",
        scope: "ATTENDEE",
        required: true,
        options: ["Grace", "Prayer"],
        minSelections: 2,
        maxSelections: 2,
        availabilityMode: "RANKED_INTEREST",
      },
      {
        id: "limited",
        key: "limited_activity",
        label: "Limited activity",
        helpText: "",
        type: "SELECT",
        scope: "ATTENDEE",
        required: false,
        options: ["A", "B"],
        availabilityMode: "CAPACITY",
        choiceLimits: { A: 4, B: 4 },
      },
    ],
  }],
};

const currentResponses = {
  first_name: "Avery",
  attendee_type: "Adult",
  shirt_size: "M",
  meal_preference: "Regular",
  childcare_needed: "No",
  session_preferences: ["Grace", "Prayer"],
};

describe("tiered attendee answer policy", () => {
  it("exposes only low-risk, non-priced and non-capacity attendee choices", () => {
    const keys = editableAttendeeFields(definition, "TIERED").map((field) => field.key);
    expect(keys).toEqual([
      "shirt_size",
      "meal_preference",
      "childcare_needed",
      "childcare_children",
      "session_preferences",
    ]);
    expect(editableAttendeeFields(definition, "VERIFY_EVERY_EDIT")).toEqual([]);
  });

  it("validates and merges a complete low-risk update", () => {
    const result = prepareTieredAttendeeAnswerUpdate({
      definition,
      policy: "TIERED",
      registrationResponses: {},
      currentResponses,
      changes: {
        shirt_size: "L",
        meal_preference: "Vegetarian",
        session_preferences: ["Prayer", "Grace"],
      },
    });
    expect(result.responses).toMatchObject({
      first_name: "Avery",
      attendee_type: "Adult",
      shirt_size: "L",
      meal_preference: "Vegetarian",
      session_preferences: ["Prayer", "Grace"],
    });
  });

  it("requires the conditional child count when childcare becomes needed", () => {
    expect(() => prepareTieredAttendeeAnswerUpdate({
      definition,
      policy: "TIERED",
      registrationResponses: {},
      currentResponses,
      changes: { childcare_needed: "Yes" },
    })).toThrowError("Number of children is required.");
  });

  it("rejects identity, sensitive and capacity-bound changes", () => {
    for (const key of [
      "first_name",
      "dietary_needs",
      "attendee_age",
      "staff_session",
      "limited_activity",
    ]) {
      expect(() => prepareTieredAttendeeAnswerUpdate({
        definition,
        policy: "TIERED",
        registrationResponses: {},
        currentResponses,
        changes: { [key]: "changed" },
      })).toThrowError(AttendeeAnswerUpdateError);
    }
  });
});
