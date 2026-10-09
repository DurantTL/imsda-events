import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registrationFormDefinitionSchema, validateTestResponses } from "@/modules/forms/definition";

const definition = registrationFormDefinitionSchema.parse({
  title: "Reopen fixture",
  description: "Fictitious.",
  confirmationMessage: "Done.",
  sections: [{
    id: "people_section",
    title: "People",
    description: "",
    fields: [
      { id: "f_first", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
      { id: "f_parent", key: "parent_phone", label: "Parent phone", helpText: "", type: "PHONE", scope: "ATTENDEE", required: false, options: [] },
    ],
  }],
});

const saved = { first_name: "Riley", parent_phone: "555-0134" };

describe("reopening a club or group registration with an old bad answer (#855)", () => {
  it("does not block when the saved phone is left alone, including while a member is added", () => {
    expect(validateTestResponses(definition, saved, {}, "ATTENDEE").isValid).toBe(false);
    expect(validateTestResponses(definition, saved, {}, "ATTENDEE", { previousResponses: saved }).isValid).toBe(true);
    // The new member has no saved answers and a good phone.
    expect(validateTestResponses(definition, { first_name: "Sam", parent_phone: "515-555-0134" }, {}, "ATTENDEE", { previousResponses: undefined }).isValid).toBe(true);
  });

  it("still blocks a changed bad value", () => {
    const result = validateTestResponses(definition, { ...saved, parent_phone: "555-0135" }, {}, "ATTENDEE", { previousResponses: saved });
    expect(result.isValid).toBe(false);
    expect(JSON.stringify(result.issues)).not.toContain("555-0135");
  });

  it("is wired through the form and both editors", () => {
    const form = readFileSync("components/public-registration-form.tsx", "utf8");
    expect(form).toContain("previousResponses: club?.previousResponses?.[attendee.clientId]");
    for (const file of ["components/club-registration-editor.tsx", "components/group-registration-editor.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/const club = useMemo\(\(\) => \(\{\s+initialAttendees,\s+previousResponses,/);
    }
  });
});
