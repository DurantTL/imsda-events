import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { applyEventTemplate } from "@/modules/event-templates/repository";
import {
  hasUnsavedTemplateEdits,
  publishDisabledReason,
  saveDisabledReason,
  UNSAVED_PUBLISH_MESSAGE,
} from "@/modules/event-templates/editor-guards";
import { parseEventTemplatePayload, validateEventTemplatePayloadReferences } from "@/modules/event-templates/domain";
import { starterDescription, starterEventTemplates, starterPayload } from "@/modules/event-templates/starters";
import {
  BLANK_CLUB_FORM_KEY,
  BLANK_FORM_KEY,
  blankFormTemplateKey,
  formTemplates,
  getFormTemplate,
  registrationFormDefinitionSchema,
  templatesForPicker,
  validateTestResponses,
} from "@/modules/forms/definition";
import { withDirectoryOptions } from "@/modules/organizations/directory-form-options";
import { listFormTemplates } from "@/modules/forms/repository";

function allFields(key: string) {
  return getFormTemplate(key)!.definition.sections.flatMap((section) => section.fields);
}

describe("blank form templates (#592)", () => {
  it.each([BLANK_FORM_KEY, BLANK_CLUB_FORM_KEY])("%s passes the same definition validation as the other templates", (key) => {
    const template = getFormTemplate(key)!;
    expect(registrationFormDefinitionSchema.safeParse(template.definition).success).toBe(true);
  });

  it("the general blank form is one Contact section with first name, last name, email and phone", () => {
    const { definition } = getFormTemplate(BLANK_FORM_KEY)!;
    expect(definition.sections.map((section) => section.title)).toEqual(["Contact"]);
    expect(allFields(BLANK_FORM_KEY).map((field) => field.key)).toEqual(["first_name", "last_name", "email", "phone"]);
    expect(definition.attendeeRoster).toBeUndefined();
  });

  it("the club blank form has a club and contact section and an empty roster with name and type fields", () => {
    const { definition } = getFormTemplate(BLANK_CLUB_FORM_KEY)!;
    expect(definition.sections.map((section) => section.title)).toEqual(["Club & contact", "Club roster"]);
    expect(definition.attendeeRoster?.enabled).toBe(true);
    const roster = definition.sections[1]!.fields;
    expect(roster.map((field) => field.key)).toEqual(["first_name", "last_name", "attendee_type"]);
    expect(roster.every((field) => field.scope === "ATTENDEE" && field.required)).toBe(true);
  });

  it.each([BLANK_FORM_KEY, BLANK_CLUB_FORM_KEY])("%s carries no prices, fees or payment settings", (key) => {
    const { definition } = getFormTemplate(key)!;
    expect(definition.payment).toBeUndefined();
    expect(JSON.stringify(definition)).not.toMatch(/priceCents|creditCents|latePricing|CALCULATED/);
  });

  it("can be test-submitted: the general form", () => {
    const { definition } = getFormTemplate(BLANK_FORM_KEY)!;
    const ok = validateTestResponses(definition, { first_name: "Sam", last_name: "Sample", email: "sam@example.test", phone: "555-0100" });
    expect(ok.isValid).toBe(true);
    expect(validateTestResponses(definition, {}).isValid).toBe(false);
  });

  it("can be test-submitted: the club form", () => {
    const definition = withDirectoryOptions(getFormTemplate(BLANK_CLUB_FORM_KEY)!.definition, { clubs: ["Sample Pathfinders"], churches: ["Sample Church"] });
    const ok = validateTestResponses(definition, {
      club_name: "Sample Pathfinders",
      director_name: "Dana Director",
      church_name: "Sample Church",
      email: "director@example.test",
      phone: "555-0101",
      first_name: "Alex",
      last_name: "Demo",
      attendee_type: "Pathfinder",
    });
    expect(ok.issues).toEqual([]);
    expect(ok.isValid).toBe(true);
  });

  it("chooses the blank form by event audience and leads the picker with it", () => {
    expect(blankFormTemplateKey("CLUB")).toBe(BLANK_CLUB_FORM_KEY);
    expect(blankFormTemplateKey("GENERAL")).toBe(BLANK_FORM_KEY);
    const templates = listFormTemplates();
    const general = templatesForPicker(templates, "GENERAL");
    const club = templatesForPicker(templates, "CLUB");
    expect(general[0]).toMatchObject({ key: BLANK_FORM_KEY, name: "Blank form" });
    expect(club[0]).toMatchObject({ key: BLANK_CLUB_FORM_KEY, name: "Blank form" });
    expect(general.filter((template) => template.key === BLANK_CLUB_FORM_KEY)).toEqual([]);
    expect(club.filter((template) => template.key === BLANK_FORM_KEY)).toEqual([]);
    expect(general.length).toBe(formTemplates.length - 1);
  });
});

describe("blank starters (#592)", () => {
  const blankEvent = starterEventTemplates.find((starter) => starter.name === "Blank event")!;
  const blankClubEvent = starterEventTemplates.find((starter) => starter.name === "Blank club event")!;

  it("defines Blank event as GENERAL / ATTENDEE_PAY and Blank club event as CLUB / DEFERRED_ORGANIZATION_INVOICE", () => {
    expect(blankEvent).toMatchObject({ audience: "GENERAL", billingMode: "ATTENDEE_PAY", formTemplateKey: BLANK_FORM_KEY });
    expect(blankClubEvent).toMatchObject({ audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", formTemplateKey: BLANK_CLUB_FORM_KEY });
  });

  it.each([["Blank event"], ["Blank club event"]])("%s has a valid payload, description and no prices", (name) => {
    const starter = starterEventTemplates.find((entry) => entry.name === name)!;
    const payload = starterPayload(starter);
    expect(() => validateEventTemplatePayloadReferences(parseEventTemplatePayload(payload))).not.toThrow();
    expect(starterDescription(starter)).toContain("no prices");
    expect(starterDescription(starter)).not.toContain("last year");
  });
});

describe("applying the blank starters through the create-from-template flow (#592)", () => {
  beforeEach(() => vi.clearAllMocks());

  const applyInput = { name: "Sample Blank 2027", slug: "sample-blank-2027", startsOn: "2027-05-01", endsOn: "2027-05-03", requestKey: "idempotency-key-0592" };

  function mockApply(payload: unknown) {
    const eventRow = { id: "event-1", name: applyInput.name, slug: applyInput.slug, audience: "GENERAL" };
    const registrationFormCreate = vi.fn().mockResolvedValue({ id: "form-1", name: "Form" });
    const membershipCreate = vi.fn().mockResolvedValue({});
    const eventCreate = vi.fn().mockResolvedValue(eventRow);
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([{ status: "PUBLISHED" }]),
      eventTemplate: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "template-1", name: "Starter" }) },
      eventTemplateVersion: { findFirst: vi.fn().mockResolvedValue({ id: "version-1", versionNumber: 1, payload }) },
      platformSettings: { upsert: vi.fn().mockResolvedValue({ defaultAttendeeEditPolicy: "VERIFY_EVERY_EDIT" }) },
      event: { create: eventCreate },
      eventMembership: { create: membershipCreate },
      eventAttendeeType: { createMany: vi.fn() },
      eventAttendeeClassification: { createMany: vi.fn() },
      registrationForm: { findUnique: vi.fn().mockResolvedValue(null), create: registrationFormCreate },
      eventMessageTemplate: { create: vi.fn() },
      eventTemplateApplication: { create: vi.fn().mockResolvedValue({ id: "application-1" }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      eventTemplateApplication: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      event: { findUnique: vi.fn().mockResolvedValue({ ...eventRow, startsAt: new Date(), endsAt: new Date() }) },
      registrationForm: { findMany: vi.fn().mockResolvedValue([]) },
      eventPaymentInstructionVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    dependencies.getPrisma.mockReturnValue(prisma);
    return { eventCreate, membershipCreate, registrationFormCreate };
  }

  it.each([
    ["Blank event", "GENERAL", "ATTENDEE_PAY", "Contact"],
    ["Blank club event", "CLUB", "DEFERRED_ORGANIZATION_INVOICE", "Club roster"],
  ])("%s creates a draft event with an admin membership and a blank form", async (name, audience, billingMode, lastSection) => {
    const starter = starterEventTemplates.find((entry) => entry.name === name)!;
    const { eventCreate, membershipCreate, registrationFormCreate } = mockApply(starterPayload(starter));

    await applyEventTemplate("template-1", "usr_actor", applyInput).catch(() => undefined);

    expect(eventCreate.mock.calls[0]![0].data).toMatchObject({ audience, billingMode, isPublished: false });
    expect(membershipCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ role: "EVENT_ADMIN", userId: "usr_actor", status: "ACTIVE" }) });
    expect(registrationFormCreate).toHaveBeenCalledTimes(1);
    const stored = registrationFormCreate.mock.calls[0]![0].data.versions.create.definition;
    expect(registrationFormDefinitionSchema.safeParse(stored).success).toBe(true);
    expect(stored.sections.at(-1).title).toBe(lastSection);
  });
});

describe("template editor unsaved-publish guard (#592)", () => {
  const saved = { name: "Retreat", description: "Synthetic.", payload: { audience: "GENERAL", formTemplateKeys: ["blank_form"] } };
  const text = (value: unknown) => JSON.stringify(value, null, 2);

  it("says to save first", () => {
    expect(UNSAVED_PUBLISH_MESSAGE).toBe("Save your changes before publishing.");
  });

  it("sees no edits when the text matches the saved payload, whatever its formatting or key order", () => {
    expect(hasUnsavedTemplateEdits({ name: saved.name, description: saved.description, payloadText: text(saved.payload) }, saved)).toBe(false);
    expect(hasUnsavedTemplateEdits({ name: saved.name, description: saved.description, payloadText: JSON.stringify({ formTemplateKeys: ["blank_form"], audience: "GENERAL" }) }, saved)).toBe(false);
  });

  it("sees unsaved edits to the payload, name, or description, and to broken JSON", () => {
    expect(hasUnsavedTemplateEdits({ name: saved.name, description: saved.description, payloadText: text({ ...saved.payload, audience: "CLUB" }) }, saved)).toBe(true);
    expect(hasUnsavedTemplateEdits({ name: "Renamed", description: saved.description, payloadText: text(saved.payload) }, saved)).toBe(true);
    expect(hasUnsavedTemplateEdits({ name: saved.name, description: "Changed", payloadText: text(saved.payload) }, saved)).toBe(true);
    expect(hasUnsavedTemplateEdits({ name: saved.name, description: saved.description, payloadText: "{ not json" }, saved)).toBe(true);
  });

  it("explains every disabled state and stays enabled otherwise", () => {
    expect(saveDisabledReason({ isArchived: true, saving: false })).toMatch(/archived/);
    expect(saveDisabledReason({ isArchived: false, saving: true })).toMatch(/in progress/);
    expect(saveDisabledReason({ isArchived: false, saving: false })).toBe("");
    expect(publishDisabledReason({ isArchived: true, isDraft: true, publishing: false })).toMatch(/archived/);
    expect(publishDisabledReason({ isArchived: false, isDraft: false, publishing: false })).toMatch(/Save as new draft/);
    expect(publishDisabledReason({ isArchived: false, isDraft: true, publishing: true })).toMatch(/in progress/);
    expect(publishDisabledReason({ isArchived: false, isDraft: true, publishing: false })).toBe("");
  });
});
