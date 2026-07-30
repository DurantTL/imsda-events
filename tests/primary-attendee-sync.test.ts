import { describe, expect, it } from "vitest";
import { getFormTemplate } from "@/modules/forms/definition";
import {
  getPrimaryAttendeeNameSync,
  syncFirstAttendeeNameChange,
} from "@/modules/forms/primary-attendee-sync";

describe("primary attendee name sync", () => {
  const definition = getFormTemplate("womens_retreat_export")!.definition;
  const sync = getPrimaryAttendeeNameSync(definition);

  it("recognizes the Women’s Retreat contact and attendee name fields", () => {
    expect(sync).toEqual({
      registrationFirstNameKey: "primary_contact_first_name",
      registrationLastNameKey: "primary_contact_last_name",
      attendeeFirstNameKey: "first_name",
      attendeeLastNameKey: "last_name",
    });
  });

  it("copies primary-contact names into blank first-attendee fields", () => {
    expect(syncFirstAttendeeNameChange(
      sync,
      "primary_contact_first_name",
      "",
      "Avery",
      {},
    )).toEqual({ first_name: "Avery" });
  });

  it("keeps following contact edits while the attendee value still matches", () => {
    expect(syncFirstAttendeeNameChange(
      sync,
      "primary_contact_last_name",
      "Smith",
      "Jones",
      { first_name: "Avery", last_name: " Smith " },
    )).toEqual({ first_name: "Avery", last_name: "Jones" });
  });

  it("preserves a deliberately different first-attendee name", () => {
    const attendee = { first_name: "Guest", last_name: "Person" };
    expect(syncFirstAttendeeNameChange(
      sync,
      "primary_contact_first_name",
      "Avery",
      "Alexis",
      attendee,
    )).toBe(attendee);
  });

  it("ignores unrelated registration fields", () => {
    const attendee = { first_name: "Avery" };
    expect(syncFirstAttendeeNameChange(
      sync,
      "primary_contact_email",
      "old@example.test",
      "new@example.test",
      attendee,
    )).toBe(attendee);
  });
});
