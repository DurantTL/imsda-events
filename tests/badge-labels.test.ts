import { describe, expect, it } from "vitest";
import {
  badgeTemplates,
  buildBadgeLabels,
  normalizeBadgeOrientation,
  normalizeBadgeShowAttendeeType,
  normalizeBadgeShowTitle,
  normalizeBadgeTextSize,
  normalizeBadgeStartingPosition,
  normalizeBadgeTemplate,
  paginateBadgeLabels,
  type BadgeLabel,
} from "@/modules/checkin/badge-labels";
import { formTemplates } from "@/modules/forms/definition";
import type { RegistrationRecord } from "@/modules/registrations/repository";

function label(index: number): BadgeLabel {
  return {
    attendeeId: `attendee-${index}`,
    attendeeType: "Adult",
    attendeeTypeLabel: "Adult",
    confirmationCode: `REG-${index}`,
    firstName: `First ${index}`,
    lastName: `Last ${index}`,
    groupLabel: "Central Church",
    shirtSize: "Adult L",
    shirtSizeConfirmed: true,
  };
}

describe("printable badge labels", () => {
  it("normalizes supported templates and sheet positions", () => {
    expect(normalizeBadgeTemplate("avery-5392")).toBe("avery-5392");
    expect(normalizeBadgeTemplate("unknown")).toBe("avery-5395");
    expect(normalizeBadgeStartingPosition("6", 8)).toBe(6);
    expect(normalizeBadgeStartingPosition("9", 8)).toBe(1);
    expect(badgeTemplates["avery-presta-94237"].perSheet).toBe(8);
  });

  it("maps retired Avery 5163 links to Presta 94237", () => {
    expect(normalizeBadgeTemplate("avery-5163")).toBe("avery-presta-94237");
    expect(normalizeBadgeTemplate("avery-presta-94237")).toBe("avery-presta-94237");
    expect(Object.keys(badgeTemplates)).not.toContain("avery-5163");
    expect(badgeTemplates["avery-presta-94237"]).toMatchObject({
      product: "Avery Presta 94237",
      label: "Rectangle labels",
      dimensions: "2 × 3 inches",
      slotWidthIn: 3,
      slotHeightIn: 2,
    });
  });

  it("paginates Presta 94237 into sheets of 8 with start positions 1-8", () => {
    const labels = Array.from({ length: 10 }, (_, index) => label(index + 1));
    expect(paginateBadgeLabels(labels, "avery-presta-94237")).toHaveLength(2);
    for (let start = 1; start <= 8; start += 1) {
      expect(normalizeBadgeStartingPosition(String(start), 8)).toBe(start);
      const sheets = paginateBadgeLabels(labels, "avery-presta-94237", start);
      expect(sheets.every((sheet) => sheet.length === 8)).toBe(true);
      expect(sheets[0].slice(0, start - 1).every((slot) => slot === null)).toBe(true);
      expect(sheets[0][start - 1]?.attendeeId).toBe("attendee-1");
      expect(sheets).toHaveLength(Math.ceil((start - 1 + 10) / 8));
    }
  });

  it("normalizes the title and text size options", () => {
    expect(normalizeBadgeShowTitle(undefined)).toBe(true);
    expect(normalizeBadgeShowTitle("1")).toBe(true);
    expect(normalizeBadgeShowTitle("0")).toBe(false);
    expect(normalizeBadgeShowTitle(["0", "1"])).toBe(true);
    expect(normalizeBadgeShowTitle(["0"])).toBe(false);
    expect(normalizeBadgeTextSize(undefined)).toBe(100);
    expect(normalizeBadgeTextSize("80")).toBe(80);
    expect(normalizeBadgeTextSize("130")).toBe(130);
    expect(normalizeBadgeTextSize("95")).toBe(100);
    expect(normalizeBadgeTextSize("huge")).toBe(100);
  });

  it("defaults badge orientation to vertical for ID sleeves", () => {
    expect(normalizeBadgeOrientation(undefined)).toBe("portrait");
    expect(normalizeBadgeOrientation("landscape")).toBe("landscape");
    expect(normalizeBadgeOrientation("sideways")).toBe("portrait");
  });

  it("leaves consumed labels blank on the first reusable sheet", () => {
    const sheets = paginateBadgeLabels(
      [label(1), label(2), label(3)],
      "avery-5392",
      5,
    );

    expect(sheets).toHaveLength(2);
    expect(sheets[0]).toHaveLength(6);
    expect(sheets[0].slice(0, 4)).toEqual([null, null, null, null]);
    expect(sheets[0][4]?.attendeeId).toBe("attendee-1");
    expect(sheets[1][0]?.attendeeId).toBe("attendee-3");
  });

  it("adds church and current shirt confirmation data to sorted badges", () => {
    const definition = formTemplates.find(
      (template) => template.key === "womens_retreat_export",
    )!.definition;
    const registrations = [{
      id: "registration-1",
      confirmationCode: "REG-WR",
      status: "SUBMITTED",
      accountHolder: { firstName: "Account", lastName: "Holder" },
      attendees: [{
        id: "attendee-z",
        firstName: "Zoe",
        lastName: "Young",
        attendeeType: "Adult",
        position: 0,
        responses: {
          shirt_size: "Adult M",
          shirt_size_confirmed_at: "2026-08-02T15:30:00.000Z",
        },
      }, {
        id: "attendee-a",
        firstName: "Ana",
        lastName: "Adams",
        attendeeType: "Teen",
        position: 1,
        responses: {},
      }],
      publicSubmission: {
        definition,
        responses: { church: "Ames SDA Church" },
        attendeeResponses: [{}, {}],
      },
    }] as unknown as RegistrationRecord[];

    const labels = buildBadgeLabels(registrations);

    expect(labels.map((entry) => entry.attendeeId)).toEqual([
      "attendee-a",
      "attendee-z",
    ]);
    expect(labels[0].groupLabel).toBe("Ames SDA Church");
    expect(labels[1]).toMatchObject({
      shirtSize: "Adult M",
      shirtSizeConfirmed: true,
    });
  });
});

describe("badge attendee-type line", () => {
  const typeField = {
    id: "field_attendee_type",
    key: "attendee_type",
    label: "Attendee type",
    helpText: "",
    type: "SELECT",
    scope: "ATTENDEE",
    required: true,
    options: ["adult", "teen"],
    optionLabels: { adult: "Adult", teen: "Teen" },
  };
  const configured = [{
    id: "t1", code: "YOUTH", label: "Youth", description: "", sortOrder: 0,
    isActive: true, minimumAge: null, maximumAge: null,
  }];
  const build = (
    attendee: Record<string, unknown>,
    fields: unknown[],
    attendeeTypeOptions: unknown[] = [],
  ) => buildBadgeLabels([{
    id: "registration-1",
    confirmationCode: "REG-T",
    status: "SUBMITTED",
    accountHolder: { firstName: "Account", lastName: "Holder" },
    attendees: [{
      id: "attendee-1",
      firstName: "Sam",
      lastName: "Sample",
      attendeeType: "CHILD",
      position: 0,
      responses: {},
      ...attendee,
    }],
    publicSubmission: {
      definition: {
        title: "Synthetic Form",
        description: "",
        confirmationMessage: "Thanks",
        sections: [{ id: "sec_one", title: "Section", description: "", fields }],
      },
      responses: {},
      attendeeResponses: [{}],
      attendeeTypeOptions,
    },
  }] as unknown as RegistrationRecord[])[0];

  it("normalizes the show-attendee-type option", () => {
    expect(normalizeBadgeShowAttendeeType(undefined)).toBe(true);
    expect(normalizeBadgeShowAttendeeType("1")).toBe(true);
    expect(normalizeBadgeShowAttendeeType("0")).toBe(false);
    expect(normalizeBadgeShowAttendeeType(["0", "1"])).toBe(true);
  });

  it("uses the option label of the attendee's own answer, not the stored value or system type", () => {
    expect(build({ responses: { attendee_type: "teen" } }, [typeField]).attendeeTypeLabel)
      .toBe("Teen");
  });

  it("ignores an attendee_type field that is not an attendee-scope choice", () => {
    const registrationScoped = { ...typeField, scope: "REGISTRATION" };
    const textField = { ...typeField, type: "TEXT", options: [], optionLabels: undefined };
    for (const field of [registrationScoped, textField]) {
      expect(build(
        { responses: { attendee_type: "teen" }, attendeeTypeDefinitionCode: "YOUTH" },
        [field],
        configured,
      ).attendeeTypeLabel).toBe("Youth");
    }
  });

  it("falls back to the event's configured type label, then the system label", () => {
    expect(build(
      { attendeeTypeDefinitionCode: "YOUTH" },
      [typeField],
      configured,
    ).attendeeTypeLabel).toBe("Youth");
    expect(build({}, [typeField]).attendeeTypeLabel).toBe("Child");
    expect(build({ attendeeType: "WORKER" }, []).attendeeTypeLabel).toBe("Worker");
  });

  it("falls back when the answer is not one of the form's options", () => {
    expect(build(
      { responses: { attendee_type: "legacy_code" }, attendeeTypeDefinitionCode: "YOUTH" },
      [typeField],
      configured,
    ).attendeeTypeLabel).toBe("Youth");
    expect(build({ responses: { attendee_type: "legacy_code" } }, [typeField]).attendeeTypeLabel)
      .toBe("Child");
  });

  it("maps a code from an ATTENDEE_TYPES-sourced field to its configured label, including a deactivated type", () => {
    const sourced = { ...typeField, options: [], optionLabels: undefined, optionSource: "ATTENDEE_TYPES" };
    const types = [
      { ...configured[0], code: "YOUTH", label: "Youth" },
      { ...configured[0], id: "t2", code: "RETIRED", label: "Retired Guest", isActive: false },
    ];
    expect(build({ responses: { attendee_type: "YOUTH" } }, [sourced], types).attendeeTypeLabel)
      .toBe("Youth");
    expect(build({ responses: { attendee_type: "RETIRED" } }, [sourced], types).attendeeTypeLabel)
      .toBe("Retired Guest");
    expect(build({ responses: { attendee_type: "UNKNOWN" } }, [sourced], types).attendeeTypeLabel)
      .toBe("Child");
  });

  it("resolves each registration against its own form version", () => {
    const registrationWith = (id: string, labels: Record<string, string>) => ({
      id,
      confirmationCode: id,
      status: "SUBMITTED",
      accountHolder: { firstName: "Account", lastName: "Holder" },
      attendees: [{
        id: `attendee-${id}`,
        firstName: "Sam",
        lastName: id,
        attendeeType: "CHILD",
        position: 0,
        responses: { attendee_type: "teen" },
      }],
      publicSubmission: {
        definition: {
          title: "Synthetic Form",
          description: "",
          confirmationMessage: "Thanks",
          sections: [{ id: "sec_one", title: "Section", description: "", fields: [
            { ...typeField, optionLabels: labels },
          ] }],
        },
        responses: {},
        attendeeResponses: [{}],
        attendeeTypeOptions: [],
      },
    });
    const labels = buildBadgeLabels([
      registrationWith("REG-A", { teen: "Teen" }),
      registrationWith("REG-B", { teen: "Youth Teen" }),
    ] as unknown as RegistrationRecord[]);
    expect(labels.map((entry) => entry.attendeeTypeLabel)).toEqual(["Teen", "Youth Teen"]);
  });
});
