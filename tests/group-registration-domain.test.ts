import { describe, expect, it } from "vitest";
import {
  estimateFromPricing,
  GROUP_BILLING_NOTICE,
  GROUP_LABEL,
  groupFormDefinition,
  groupFormProblem,
  groupRegistrationEditInputSchema,
  groupSeatType,
  isValidGroupAttendeeClientId,
  MAX_GROUP_ATTENDEES,
  parseGroupAge,
} from "@/modules/group-registrations/domain";
import { getFormTemplate, registrationFormDefinitionSchema } from "@/modules/forms/definition";

// Synthetic forms only.
const field = (
  key: string,
  options: { type?: string; scope?: "ATTENDEE" | "REGISTRATION"; required?: boolean; optionSource?: string; conditional?: { fieldKey: string; operator: "EQUALS"; value: string }; label?: string } = {},
) => ({
  id: `f_${key}`,
  key,
  label: options.label ?? key,
  helpText: "",
  type: options.type ?? "TEXT",
  scope: options.scope ?? "REGISTRATION",
  required: options.required ?? false,
  options: [] as string[],
  ...(options.optionSource ? { optionSource: options.optionSource } : {}),
  ...(options.conditional ? { conditional: options.conditional } : {}),
});

function clubForm(attendeeFields = [
  field("first_name", { scope: "ATTENDEE", required: true }),
  field("last_name", { scope: "ATTENDEE", required: true }),
  field("attendee_age", { scope: "ATTENDEE", type: "NUMBER", required: true }),
]) {
  return registrationFormDefinitionSchema.parse({
    title: "Club weekend",
    description: "",
    confirmationMessage: "Done",
    attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Person", addButtonLabel: "Add" },
    sections: [
      {
        id: "s_club", title: "Club", description: "", fields: [
          field("club_name", { type: "SELECT", required: true, optionSource: "CLUBS_DIRECTORY" }),
          field("club_name_other", { required: true, conditional: { fieldKey: "club_name", operator: "EQUALS", value: "__NOT_LISTED__" } }),
          field("church_name", { type: "SELECT", required: true, optionSource: "CHURCHES_DIRECTORY" }),
          field("church_name_other", { required: true, conditional: { fieldKey: "church_name", operator: "EQUALS", value: "__NOT_LISTED__" } }),
          field("club_note_for_other", { conditional: { fieldKey: "club_name_other", operator: "EQUALS", value: "x" } }),
        ],
      },
      {
        id: "s_contact", title: "Contact", description: "", fields: [
          field("director_name", { required: true, label: "Club director" }),
          field("email", { type: "EMAIL", required: true }),
        ],
      },
      { id: "s_people", title: "People", description: "", fields: attendeeFields },
    ],
  });
}

const keysOf = (definition: ReturnType<typeof clubForm>) => definition.sections.flatMap((section) => section.fields.map((entry) => entry.key));

describe("group form (#650)", () => {
  it("calls non-club registrants only Group, and tells them they are billed after the event", () => {
    expect(GROUP_LABEL).toBe("Group");
    expect(GROUP_LABEL.toLowerCase()).not.toContain("homeschool");
    expect(GROUP_BILLING_NOTICE).toBe("You'll be billed after the event.");
  });

  it("drops every question that would tie a group to a club or church, and what only shows for them", () => {
    const group = groupFormDefinition(clubForm());
    const keys = keysOf(group);
    expect(keys).not.toContain("club_name");
    expect(keys).not.toContain("club_name_other");
    expect(keys).not.toContain("church_name");
    expect(keys).not.toContain("church_name_other");
    // Conditional on a removed field's own dependent, however deep the chain.
    expect(keys).not.toContain("club_note_for_other");
    expect(keys).toEqual(expect.arrayContaining(["director_name", "email", "first_name", "last_name", "attendee_age"]));
  });

  it("drops plain-text club and church questions too, matched by key or label", () => {
    const definition = registrationFormDefinitionSchema.parse({
      title: "Text club form", description: "", confirmationMessage: "Done",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Person", addButtonLabel: "Add" },
      sections: [{ id: "s_all", title: "All", description: "", fields: [
        field("club_name"), field("home_church", { label: "Sponsoring church" }), field("email", { type: "EMAIL", required: true }),
        field("first_name", { scope: "ATTENDEE", required: true }), field("last_name", { scope: "ATTENDEE", required: true }),
        field("attendee_age", { scope: "ATTENDEE", type: "NUMBER", required: true }),
      ] }],
    });
    const keys = keysOf(groupFormDefinition(definition));
    expect(keys).not.toContain("club_name");
    expect(keys).not.toContain("home_church");
    expect(keys).toContain("email");
  });

  it("relabels the club director as the contact, and leaves an attendee's own questions alone", () => {
    const group = groupFormDefinition(clubForm());
    expect(group.sections.flatMap((section) => section.fields).find((entry) => entry.key === "director_name")?.label).toBe("Contact name");
    expect(group.sections.find((section) => section.id === "s_people")?.fields).toHaveLength(3);
  });

  it("shows a group no club, church, Pathfinder or director wording, and the billing notice as the confirmation (Honors Weekend template)", () => {
    const template = getFormTemplate("honors_weekend");
    expect(template).toBeTruthy();
    const group = groupFormDefinition(registrationFormDefinitionSchema.parse(template!.definition));
    expect(group.description).toBe("");
    expect(group.confirmationMessage).toContain(GROUP_BILLING_NOTICE);
    expect(group.sections[0]).toMatchObject({ title: "Contact", description: "Enter the contact person's information." });
    expect(group.attendeeRoster).toMatchObject({ attendeeLabel: "Person", addButtonLabel: "Add another person" });
    const shown = JSON.stringify({
      description: group.description,
      confirmationMessage: group.confirmationMessage,
      roster: group.attendeeRoster,
      sections: group.sections.map((section) => ({ title: section.title, description: section.description, fields: section.fields.map((entry) => ({ label: entry.label, helpText: entry.helpText })) })),
    });
    expect(shown).not.toMatch(/club|church|pathfinder|director|invoiced/i);
  });

  it("removes a section left with no questions, and never changes the source form", () => {
    const source = clubForm();
    const before = JSON.stringify(source);
    const group = groupFormDefinition(source);
    expect(group.sections.map((section) => section.id)).toEqual(["s_contact", "s_people"]);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("needs the club form rules plus a required, always-shown age question", () => {
    expect(groupFormProblem(groupFormDefinition(clubForm()))).toBeNull();
    const noAge = clubForm([field("first_name", { scope: "ATTENDEE", required: true }), field("last_name", { scope: "ATTENDEE", required: true })]);
    expect(groupFormProblem(groupFormDefinition(noAge))).toMatch(/no attendee age question/i);
    const optionalAge = clubForm([
      field("first_name", { scope: "ATTENDEE", required: true }), field("last_name", { scope: "ATTENDEE", required: true }),
      field("attendee_age", { scope: "ATTENDEE", type: "NUMBER", required: false }),
    ]);
    expect(groupFormProblem(groupFormDefinition(optionalAge))).toMatch(/must be required/i);
    const birthDate = clubForm([
      field("first_name", { scope: "ATTENDEE", required: true }), field("last_name", { scope: "ATTENDEE", required: true }),
      field("attendee_age", { scope: "ATTENDEE", type: "NUMBER", required: true }), field("birth_date", { scope: "ATTENDEE", type: "DATE" }),
    ]);
    expect(groupFormProblem(groupFormDefinition(birthDate))).toMatch(/birth dates/i);
  });
});

describe("group people", () => {
  it("reads an age only as a whole number of years from 0 to 120", () => {
    expect(parseGroupAge("12")).toBe(12);
    expect(parseGroupAge(" 40 ")).toBe(40);
    expect(parseGroupAge(0)).toBe(0);
    expect(parseGroupAge(120)).toBe(120);
    for (const bad of ["", "abc", "12.5", "-1", 121, -3, 1.5, null, undefined, "1e2", "200"]) expect(parseGroupAge(bad)).toBeNull();
  });

  it("decides seat use from the age the server read: under 18 uses a class seat, adults do not", () => {
    expect(groupSeatType(9)).toBe("YOUTH");
    expect(groupSeatType(17)).toBe("YOUTH");
    expect(groupSeatType(18)).toBe("ADULT");
    expect(groupSeatType(40)).toBe("ADULT");
  });

  it("accepts only safe ids for people the browser makes up", () => {
    expect(isValidGroupAttendeeClientId("p-1_a")).toBe(true);
    expect(isValidGroupAttendeeClientId("")).toBe(false);
    expect(isValidGroupAttendeeClientId("a b")).toBe(false);
    expect(isValidGroupAttendeeClientId("../x")).toBe(false);
    expect(isValidGroupAttendeeClientId("x".repeat(65))).toBe(false);
  });
});

describe("estimated total", () => {
  it("is the sum of the server's price lines, with a shared per-person price when everyone pays the same", () => {
    expect(estimateFromPricing({
      lineItems: [{ amountCents: 2500, attendeeIndex: 0 }, { amountCents: 2500, attendeeIndex: 1 }, { amountCents: 2500, attendeeIndex: 2 }],
      attendeeCount: 3,
    })).toEqual({ totalCents: 7500, peopleCount: 3, perPersonCents: 2500 });
  });

  it("shows no shared price when people pay differently or a fee covers the whole registration", () => {
    expect(estimateFromPricing({ lineItems: [{ amountCents: 2500, attendeeIndex: 0 }, { amountCents: 1500, attendeeIndex: 1 }], attendeeCount: 2 }).perPersonCents).toBeNull();
    const withFee = estimateFromPricing({ lineItems: [{ amountCents: 2500, attendeeIndex: 0 }, { amountCents: 500 }], attendeeCount: 1 });
    expect(withFee).toEqual({ totalCents: 3000, peopleCount: 1, perPersonCents: null });
  });

  it("counts free people (no line) as $0 people, so a mixed group shows no shared price", () => {
    const estimate = estimateFromPricing({ lineItems: [{ amountCents: 2500, attendeeIndex: 0 }], attendeeCount: 2 });
    expect(estimate).toEqual({ totalCents: 2500, peopleCount: 2, perPersonCents: null });
  });
});

describe("reopening a group registration", () => {
  const valid = {
    clientRequestId: "0b1f6f3e-7f3a-4c3e-9a6a-0a3a4d5e6f70",
    expectedUpdatedAt: "2026-10-15T15:00:00.000Z",
    attendees: [{ attendeeId: "att-1", responses: { first_name: "Alex" } }, { attendeeId: null, clientId: "new-1", responses: {} }],
  };

  it("takes kept and new people, and an optional location", () => {
    expect(groupRegistrationEditInputSchema.parse(valid).attendees).toHaveLength(2);
    expect(groupRegistrationEditInputSchema.parse({ ...valid, locationId: "loc-1" }).locationId).toBe("loc-1");
  });

  it("refuses an empty group, too many people, unknown keys, and unsafe ids", () => {
    expect(groupRegistrationEditInputSchema.safeParse({ ...valid, attendees: [] }).success).toBe(false);
    expect(groupRegistrationEditInputSchema.safeParse({
      ...valid, attendees: Array.from({ length: MAX_GROUP_ATTENDEES + 1 }, (_, index) => ({ attendeeId: null, clientId: `p${index}`, responses: {} })),
    }).success).toBe(false);
    expect(groupRegistrationEditInputSchema.safeParse({ ...valid, organizationId: "club-1" }).success).toBe(false);
    expect(groupRegistrationEditInputSchema.safeParse({ ...valid, attendees: [{ attendeeId: null, clientId: "a b", responses: {} }] }).success).toBe(false);
    expect(groupRegistrationEditInputSchema.safeParse({ ...valid, clientRequestId: "not-a-uuid" }).success).toBe(false);
  });
});
