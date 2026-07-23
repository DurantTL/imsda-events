import { describe, expect, it } from "vitest";
import {
  registrationFormDefinitionSchema,
  summarizeChoiceUsage,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";
import {
  preparePublicRegistration,
  publicRegistrationInputSchema,
  type PublicRegistrationInput,
} from "@/modules/forms/public-domain";

const idempotencyKey = "9f8f0f3a-4c73-4d7e-89a4-f54d4fe0c388";

function rosterDefinition(cabinLimit = 2): RegistrationFormDefinition {
  return registrationFormDefinitionSchema.parse({
    title: "Repeatable roster verification",
    description: "Fictitious household registration used by unit tests.",
    confirmationMessage: "Your local roster test was received.",
    attendeeRoster: {
      enabled: true,
      minAttendees: 1,
      maxAttendees: 6,
      attendeeLabel: "Attendee",
      addButtonLabel: "Add another attendee",
    },
    payment: {
      enabled: true,
      currency: "USD",
      paymentMethodFieldKey: "payment_method",
      cardOptionValue: "Credit / debit card",
      percentageBasisPoints: 290,
      fixedFeeCents: 30,
      passFeeToRegistrant: true,
    },
    sections: [
      {
        id: "registration_details",
        title: "Registration details",
        description: "",
        fields: [
          {
            id: "contact_name_field",
            key: "contact_name",
            label: "Primary contact name",
            helpText: "",
            type: "TEXT",
            scope: "REGISTRATION",
            required: true,
            options: [],
          },
          {
            id: "contact_email_field",
            key: "email",
            label: "Primary contact email",
            helpText: "",
            type: "EMAIL",
            scope: "REGISTRATION",
            required: true,
            options: [],
          },
          {
            id: "contact_phone_field",
            key: "contact_phone",
            label: "Primary contact phone",
            helpText: "",
            type: "PHONE",
            scope: "REGISTRATION",
            required: false,
            options: [],
          },
          {
            id: "payment_method_field",
            key: "payment_method",
            label: "Payment method",
            helpText: "",
            type: "RADIO",
            scope: "REGISTRATION",
            required: true,
            options: ["Pay later", "Credit / debit card"],
          },
          {
            id: "group_fee_field",
            key: "group_fee",
            label: "Registration setup",
            helpText: "",
            type: "CALCULATED",
            scope: "REGISTRATION",
            required: false,
            options: [],
            priceCents: 5000,
          },
        ],
      },
      {
        id: "attendee_details",
        title: "Attendee details",
        description: "",
        fields: [
          {
            id: "attendee_name_field",
            key: "attendee_name",
            label: "Attendee name",
            helpText: "",
            type: "TEXT",
            scope: "ATTENDEE",
            required: true,
            options: [],
          },
          {
            id: "attendee_email_field",
            key: "attendee_email",
            label: "Attendee email",
            helpText: "",
            type: "EMAIL",
            scope: "ATTENDEE",
            required: false,
            options: [],
          },
          {
            id: "attendee_phone_field",
            key: "attendee_phone",
            label: "Attendee phone",
            helpText: "",
            type: "PHONE",
            scope: "ATTENDEE",
            required: false,
            options: [],
          },
          {
            id: "attendee_type_field",
            key: "attendee_type",
            label: "Attendee type",
            helpText: "",
            type: "RADIO",
            scope: "ATTENDEE",
            required: true,
            options: ["Adult", "Child", "Worker"],
          },
          {
            id: "lodging_field",
            key: "lodging",
            label: "Lodging",
            helpText: "",
            type: "RADIO",
            scope: "ATTENDEE",
            required: true,
            options: ["Shared cabin", "Commuting"],
            availabilityMode: "CAPACITY",
            choiceLimits: { "Shared cabin": cabinLimit },
          },
          {
            id: "attendee_fee_field",
            key: "attendee_fee",
            label: "Attendee registration",
            helpText: "",
            type: "CALCULATED",
            scope: "ATTENDEE",
            required: false,
            options: [],
            priceCents: 10000,
            conditional: {
              fieldKey: "attendee_type",
              operator: "NOT_EQUALS",
              value: "Worker",
            },
          },
          {
            id: "childcare_field",
            key: "childcare",
            label: "Childcare",
            helpText: "",
            type: "RADIO",
            scope: "ATTENDEE",
            required: true,
            options: ["No", "Yes"],
            choicePricesCents: { No: 0, Yes: 1500 },
            conditional: {
              fieldKey: "attendee_type",
              operator: "EQUALS",
              value: "Child",
            },
          },
        ],
      },
    ],
  });
}

function parsedInput(
  attendees: PublicRegistrationInput["attendees"],
  responses: Record<string, unknown> = {
    contact_name: "Roster Contact",
    email: "roster.contact@example.test",
    payment_method: "Credit / debit card",
  },
) {
  return publicRegistrationInputSchema.parse({
    versionId: "roster-version-1",
    idempotencyKey,
    responses,
    attendees,
    website: "",
  });
}

function adult(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "attendee-adult",
    responses: {
      attendee_name: "Avery Adult",
      attendee_email: "AVERY.ADULT@EXAMPLE.TEST",
      attendee_phone: " 555-0101 ",
      attendee_type: "Adult",
      lodging: "Shared cabin",
      childcare: "Yes",
      attendee_fee: 1,
      ...overrides,
    },
  };
}

function child(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "attendee-child",
    responses: {
      attendee_name: "Casey Child",
      attendee_type: "Child",
      lodging: "Shared cabin",
      childcare: "Yes",
      ...overrides,
    },
  };
}

function worker(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "attendee-worker",
    responses: {
      attendee_name: "Wren Worker",
      attendee_type: "Worker",
      lodging: "Commuting",
      attendee_fee: 1,
      ...overrides,
    },
  };
}

describe("repeatable public attendee rosters", () => {
  it("normalizes registration and attendee scopes while deriving contact and attendee identities", () => {
    const definition = rosterDefinition();
    const prepared = preparePublicRegistration(
      definition,
      parsedInput(
        [
          adult({ attendee_name: "  Avery Adult ", attendee_email: " AVERY.ADULT@EXAMPLE.TEST " }),
          child(),
        ],
        {
          contact_name: "  Roster Contact ",
          email: " ROSTER.CONTACT@EXAMPLE.TEST ",
          contact_phone: " 555-0100 ",
          payment_method: "Pay later",
        },
      ),
      {
        timeZone: "America/Chicago",
        now: new Date("2026-08-01T12:00:00Z"),
      },
    );

    expect(prepared.isValid).toBe(true);
    expect(prepared.responses).toEqual({
      contact_name: "Roster Contact",
      email: "ROSTER.CONTACT@EXAMPLE.TEST",
      contact_phone: "555-0100",
      payment_method: "Pay later",
    });
    expect(prepared.identity).toEqual({
      firstName: "Roster",
      lastName: "Contact",
      email: "roster.contact@example.test",
      phone: "555-0100",
    });
    expect(prepared.attendees[0].responses).toEqual({
      attendee_name: "Avery Adult",
      attendee_email: "AVERY.ADULT@EXAMPLE.TEST",
      attendee_phone: "555-0101",
      attendee_type: "Adult",
      lodging: "Shared cabin",
    });
    expect(prepared.attendees[0].identity).toEqual({
      firstName: "Avery",
      lastName: "Adult",
      email: "avery.adult@example.test",
      phone: "555-0101",
    });
    expect(prepared.attendees[1].identity).toMatchObject({
      firstName: "Casey",
      lastName: "Child",
      email: null,
    });
  });

  it("prefers a registration-scoped contact name over an attendee name", () => {
    const definition = rosterDefinition();
    const contactField = definition.sections[0].fields.find((field) => field.key === "contact_name")!;
    contactField.key = "director_name";
    contactField.label = "Club director";
    const prepared = preparePublicRegistration(
      definition,
      parsedInput([adult()], {
        director_name: "Drew Director",
        email: "director@example.test",
        payment_method: "Pay later",
      }),
      {
        timeZone: "America/Chicago",
        now: new Date("2026-08-01T12:00:00Z"),
      },
    );

    expect(prepared.isValid).toBe(true);
    expect(prepared.identity).toMatchObject({
      firstName: "Drew",
      lastName: "Director",
      email: "director@example.test",
    });
    expect(prepared.attendees[0].identity).toMatchObject({
      firstName: "Avery",
      lastName: "Adult",
    });
  });

  it("keeps a separately entered attendee identity when repeat mode is disabled", () => {
    const definition = rosterDefinition();
    definition.attendeeRoster = {
      ...definition.attendeeRoster!,
      enabled: false,
    };
    const prepared = preparePublicRegistration(
      definition,
      publicRegistrationInputSchema.parse({
        versionId: "roster-version-1",
        idempotencyKey,
        responses: {
          contact_name: "Drew Director",
          email: "director@example.test",
          payment_method: "Pay later",
          attendee_name: "Avery Attendee",
          attendee_type: "Adult",
          lodging: "Commuting",
        },
        website: "",
      }),
      {
        timeZone: "America/Chicago",
        now: new Date("2026-08-01T12:00:00Z"),
      },
    );

    expect(prepared.isValid).toBe(true);
    expect(prepared.identity).toMatchObject({
      firstName: "Drew",
      lastName: "Director",
    });
    expect(prepared.attendees[0].identity).toMatchObject({
      firstName: "Avery",
      lastName: "Attendee",
    });
  });

  it("prices registration fields once, attendee fields per person, and gross-ups one card fee", () => {
    const definition = rosterDefinition();
    const prepared = preparePublicRegistration(
      definition,
      parsedInput([adult(), child(), worker()]),
      {
        timeZone: "America/Chicago",
        now: new Date("2026-08-01T12:00:00Z"),
      },
    );

    const expectedSubtotalCents = 5000 + 10000 + 10000 + 1500;
    const expectedTotalCents = Math.ceil((expectedSubtotalCents + 30) / (1 - 0.029));

    expect(prepared.isValid).toBe(true);
    expect(prepared.calculation).toMatchObject({
      subtotalCents: expectedSubtotalCents,
      processingFeeCents: expectedTotalCents - expectedSubtotalCents,
      totalCents: expectedTotalCents,
    });
    expect(prepared.calculation.lineItems.map((item) => item.key)).toEqual([
      "group_fee",
      "attendees.0.attendee_fee",
      "attendees.1.attendee_fee",
      "attendees.1.childcare",
    ]);
    expect(new Set(prepared.calculation.lineItems.map((item) => item.key)).size).toBe(4);
    expect(prepared.calculation.lineItems).not.toContainEqual(
      expect.objectContaining({ key: "attendees.2.attendee_fee" }),
    );
  });

  it("applies attendee conditional logic independently and reports the exact attendee path", () => {
    const definition = rosterDefinition();
    const prepared = preparePublicRegistration(
      definition,
      parsedInput([
        adult({ childcare: "Yes" }),
        child({ childcare: undefined }),
      ]),
      {
        timeZone: "America/Chicago",
        now: new Date("2026-08-01T12:00:00Z"),
      },
    );

    expect(prepared.attendees[0].responses).not.toHaveProperty("childcare");
    expect(prepared.issues).toContainEqual(expect.objectContaining({
      code: "INVALID_RESPONSE",
      key: "childcare",
      path: "attendees.1.responses.childcare",
      attendeeIndex: 1,
      message: "Childcare is required.",
    }));
    expect(prepared.isValid).toBe(false);
  });

  it("rejects capacity requested twice within the same roster when only one spot remains", () => {
    const definition = rosterDefinition(2);
    const usage = summarizeChoiceUsage(definition, []);
    usage.lodging["Shared cabin"].total = 1;
    const prepared = preparePublicRegistration(
      definition,
      parsedInput([adult(), child()]),
      {
        timeZone: "America/Chicago",
        now: new Date("2026-08-01T12:00:00Z"),
        usage,
      },
    );

    expect(prepared.issues).toContainEqual(expect.objectContaining({
      code: "INVALID_RESPONSE",
      key: "lodging",
      attendeeIndex: 1,
      message: "Shared cabin has reached its limit of 2.",
    }));
    expect(prepared.issues).not.toContainEqual(expect.objectContaining({
      key: "lodging",
      attendeeIndex: 0,
    }));
    expect(prepared.isValid).toBe(false);
  });

  it("rejects response fields submitted in the wrong scope", () => {
    const definition = rosterDefinition();
    const prepared = preparePublicRegistration(
      definition,
      parsedInput(
        [{
          ...adult(),
          responses: {
            ...adult().responses,
            email: "wrong-scope@example.test",
          },
        }],
        {
          contact_name: "Roster Contact",
          email: "roster.contact@example.test",
          payment_method: "Pay later",
          attendee_name: "Wrong Scope",
        },
      ),
      {
        timeZone: "America/Chicago",
        now: new Date("2026-08-01T12:00:00Z"),
      },
    );

    expect(prepared.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "UNKNOWN_FIELD",
        key: "attendee_name",
        path: "responses.attendee_name",
      }),
      expect.objectContaining({
        code: "UNKNOWN_FIELD",
        key: "email",
        path: "attendees.0.responses.email",
        attendeeIndex: 0,
      }),
    ]));
    expect(prepared.responses).not.toHaveProperty("attendee_name");
    expect(prepared.attendees[0].responses).not.toHaveProperty("email");
  });

  it("strictly rejects duplicate or blank client IDs and unrecognized attendee properties", () => {
    const base = {
      versionId: "roster-version-1",
      idempotencyKey,
      responses: {},
      website: "",
    };

    expect(publicRegistrationInputSchema.safeParse({
      ...base,
      attendees: [
        { clientId: "duplicate", responses: {} },
        { clientId: "duplicate", responses: {} },
      ],
    }).success).toBe(false);
    expect(publicRegistrationInputSchema.safeParse({
      ...base,
      attendees: [{ clientId: "   ", responses: {} }],
    }).success).toBe(false);
    expect(publicRegistrationInputSchema.safeParse({
      ...base,
      attendees: [{ clientId: "attendee-1", responses: {}, totalCents: 1 }],
    }).success).toBe(false);
  });
});
