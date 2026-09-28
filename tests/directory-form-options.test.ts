import { describe, expect, it } from "vitest";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import {
  hasDirectoryOptionSource,
  stripDirectoryOptions,
  withDirectoryOptions,
} from "@/modules/organizations/directory-form-options";

const directory = { clubs: ["Ankeny Son-Seekers", "Fulton Foxes"], churches: ["Ankeny SDA Church"] };

const sourcedDefinition = registrationFormDefinitionSchema.parse({
  title: "Directory-sourced form",
  description: "",
  confirmationMessage: "Done",
  sections: [{
    id: "s_contact",
    title: "Contact",
    description: "",
    fields: [
      { id: "f_club", key: "club_name", label: "Club", helpText: "", type: "SELECT", scope: "REGISTRATION", required: true, options: [], optionSource: "CLUBS_DIRECTORY" },
      { id: "f_church", key: "church_name", label: "Church", helpText: "", type: "SELECT", scope: "REGISTRATION", required: false, options: [], optionSource: "CHURCHES_DIRECTORY" },
      { id: "f_email", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
    ],
  }],
});

const plainDefinition = registrationFormDefinitionSchema.parse({
  title: "Plain form",
  description: "",
  confirmationMessage: "Done",
  sections: [{ id: "s_email", title: "Section", description: "", fields: [
    { id: "f_email", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
  ] }],
});

describe("directory form options (#482)", () => {
  it("reports whether a definition uses a directory option source", () => {
    expect(hasDirectoryOptionSource(sourcedDefinition)).toBe(true);
    expect(hasDirectoryOptionSource(plainDefinition)).toBe(false);
  });

  it("hydrates a directory-sourced field with the live directory plus \"Not listed\"", () => {
    const hydrated = withDirectoryOptions(sourcedDefinition, directory);
    const fields = hydrated.sections[0].fields;
    expect(fields.find((f) => f.key === "club_name")!.options).toEqual(["Ankeny Son-Seekers", "Fulton Foxes", "Not listed"]);
    expect(fields.find((f) => f.key === "church_name")!.options).toEqual(["Ankeny SDA Church", "Not listed"]);
    // An ordinary field is untouched.
    expect(fields.find((f) => f.key === "email")!.options).toEqual([]);
  });

  it("leaves a form with no directory field untouched", () => {
    expect(withDirectoryOptions(plainDefinition, directory)).toBe(plainDefinition);
  });

  it("strips hydrated options back out before persisting, leaving only the source designation", () => {
    const hydrated = withDirectoryOptions(sourcedDefinition, directory);
    const stripped = stripDirectoryOptions(hydrated);
    const club = stripped.sections[0].fields.find((f) => f.key === "club_name")!;
    expect(club.options).toEqual([]);
    expect(club.optionSource).toBe("CLUBS_DIRECTORY");
  });

  it("round-trips: stripped-and-rehydrated options match a direct hydration", () => {
    const hydrated = withDirectoryOptions(sourcedDefinition, directory);
    const rehydrated = withDirectoryOptions(stripDirectoryOptions(hydrated), directory);
    expect(rehydrated).toEqual(hydrated);
  });
});
