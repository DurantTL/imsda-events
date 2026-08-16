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
});
