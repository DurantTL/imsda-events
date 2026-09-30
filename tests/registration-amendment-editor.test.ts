import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RegistrationAmendmentEditor } from "@/components/registration-amendment-editor";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import type { RegistrationRecord } from "@/modules/registrations/repository";

const definition = registrationFormDefinitionSchema.parse({
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
    id: "attendees",
    title: "Attendees",
    description: "",
    fields: [{
      id: "first-name",
      key: "first_name",
      label: "First name",
      helpText: "",
      type: "TEXT",
      scope: "ATTENDEE",
      required: true,
      options: [],
    }, {
      id: "last-name",
      key: "last_name",
      label: "Last name",
      helpText: "",
      type: "TEXT",
      scope: "ATTENDEE",
      required: true,
      options: [],
    }, {
      id: "attendee-type",
      key: "attendee_type",
      label: "Attendee type",
      helpText: "",
      type: "SELECT",
      scope: "ATTENDEE",
      required: true,
      options: [],
      optionSource: "ATTENDEE_TYPES",
    }],
  }],
});

const registration = {
  id: "registration-1",
  updatedAt: "2026-08-15T12:00:00.000Z",
  attendees: [{
    id: "attendee-1",
    responses: { first_name: "Avery", attendee_type: "legacy" },
    attendeeTypeDefinitionCode: "legacy",
  }],
  publicSubmission: {
    responses: {},
    definition,
    attendeeTypeOptions: [
      { code: "adult", label: "Adult", description: "", isActive: true, sortOrder: 0 },
      { code: "legacy", label: "Legacy attendee", description: "", isActive: false, sortOrder: 1 },
    ],
  },
} as unknown as RegistrationRecord;

describe("registration amendment choice rendering", () => {
  it("renders configured active and hydrated historical attendee-type labels", () => {
    const markup = renderToStaticMarkup(createElement(RegistrationAmendmentEditor, {
      eventId: "event-1",
      registration,
      onCancel: () => undefined,
      onSaved: () => undefined,
    }));

    expect(markup).toContain(">Adult<");
    expect(markup).toContain(">Legacy attendee<");
    expect(markup).not.toContain(">adult<");
    expect(markup).not.toContain(">legacy<");
  });

  it("renders a group registration from the group form, without club or church fields (#650)", () => {
    const clubForm = registrationFormDefinitionSchema.parse({
      ...definition,
      sections: [
        { id: "club", title: "Club & contact", description: "Select the Pathfinder club.", fields: [
          { id: "club-name", key: "club_name", label: "Pathfinder club", helpText: "", type: "SELECT", scope: "REGISTRATION", required: true, options: ["Some Club"], optionSource: "CLUBS_DIRECTORY" },
          { id: "church-name", key: "church_name", label: "Church", helpText: "", type: "SELECT", scope: "REGISTRATION", required: false, options: ["Some Church"], optionSource: "CHURCHES_DIRECTORY" },
          { id: "director", key: "director_name", label: "Club director", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
        ] },
        ...definition.sections,
      ],
    });
    const render = (isGroup: boolean) => renderToStaticMarkup(createElement(RegistrationAmendmentEditor, {
      eventId: "event-1",
      registration: { ...registration, isGroup, publicSubmission: { ...registration.publicSubmission, responses: {}, definition: clubForm } } as unknown as RegistrationRecord,
      onCancel: () => undefined,
      onSaved: () => undefined,
    }));
    const group = render(true);
    expect(group).not.toMatch(/Pathfinder club|Church|Club director|Club &amp; contact/);
    expect(group).toContain("Contact name");
    expect(render(false)).toContain("Pathfinder club");
  });
});
