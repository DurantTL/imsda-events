import { describe, expect, it } from "vitest";
import {
  EventTemplateReferenceError,
  parseEventTemplatePayload,
  templateBillingMode,
  validateEventTemplatePayloadReferences,
} from "@/modules/event-templates/domain";
import {
  pendingStarterEvents,
  starterDescription,
  starterEventTemplates,
  starterPayload,
} from "@/modules/event-templates/starters";
import { formTemplates, getFormTemplate } from "@/modules/forms/definition";

const wantedNames = ["Blank event", "Blank club event", "Women's Retreat", "Man Camp", "Spring Camporee", "Fall Camporee", "Camp Meeting", "Honors Weekend", "Pathfinder Leadership Weekend", "TLT Retreat", "Outdoor School", "Hispanic Institute of Evangelism"];

function fieldsOf(formKey: string) {
  const definition = getFormTemplate(formKey)!.definition;
  return definition.sections.flatMap((section) => section.fields);
}

describe("starter event templates (#546)", () => {
  it("covers the two blank starters and the ten events with a form, with unique stable keys", () => {
    expect(starterEventTemplates.map((starter) => starter.name)).toEqual(wantedNames);
    expect(new Set(starterEventTemplates.map((starter) => starter.starterKey)).size).toBe(starterEventTemplates.length);
  });

  it("creates Fall Camporee as a starter and no longer lists it as pending (#593)", () => {
    expect(pendingStarterEvents).toEqual([]);
    expect(starterEventTemplates.some((starter) => starter.starterKey === "fall_camporee")).toBe(true);
  });

  it.each(starterEventTemplates.map((starter) => [starter.name, starter] as const))("%s passes validation", (_name, starter) => {
    const payload = starterPayload(starter);
    expect(() => validateEventTemplatePayloadReferences(parseEventTemplatePayload(payload))).not.toThrow();
    expect(payload.starterKey).toBe(starter.starterKey);
    expect(payload.formTemplateKeys).toEqual([starter.formTemplateKey]);
    expect(formTemplates.some((form) => form.key === starter.formTemplateKey)).toBe(true);
  });

  it.each(starterEventTemplates.map((starter) => [starter.name, starter] as const))("%s carries no pricing, capacity, waitlist or message defaults", (_name, starter) => {
    const payload = starterPayload(starter);
    // Locations carry a null capacity and null date offsets: only a set value would be a capacity.
    const json = JSON.stringify({ ...payload, locations: undefined });
    expect(payload.locations?.every((location) => location.capacity === null)).not.toBe(false);
    expect(json).not.toMatch(/price|pricing|capacity|cents|limit/i);
    expect(payload.moduleEnablement.waitlistEnabled).toBe(false);
    expect(payload.moduleEnablement.autoPromoteWaitlist).toBe(false);
    expect(payload.messageTemplateDefaults).toEqual([]);
    expect(payload.attendeeTypes).toEqual([]);
    expect(Object.keys(payload).filter((key) => key !== "locations").sort()).toEqual([
      "attendeeClassifications", "attendeeTypes", "audience", "billingMode", "brandingDefaults", "formTemplateKeys",
      "messageTemplateDefaults", "moduleEnablement", "reportSelections", "starterKey",
    ]);
    expect("locations" in payload).toBe(starter.starterKey === "fall_camporee");
  });

  it("bills every CLUB starter to the church so directors can see the event (#565)", () => {
    // Church or school billing on a GENERAL event is allowed (#606): these individual and school-group starters take no online payment.
    const generalChurchBilled = ["leadership_weekend", "outdoor_school"];
    for (const starter of starterEventTemplates) {
      const payload = parseEventTemplatePayload(starterPayload(starter));
      expect(starter.billingMode).toBe(starter.audience === "CLUB" || generalChurchBilled.includes(starter.starterKey) ? "DEFERRED_ORGANIZATION_INVOICE" : "ATTENDEE_PAY");
      expect(payload.billingMode).toBe(starter.billingMode);
      expect(templateBillingMode(payload)).toBe(starter.billingMode);
    }
    const honors = starterEventTemplates.find((starter) => starter.starterKey === "honors_weekend")!;
    expect(templateBillingMode(parseEventTemplatePayload(starterPayload(honors)))).toBe("DEFERRED_ORGANIZATION_INVOICE");
  });

  it("applies church billing to a stored CLUB payload that predates the billing field", () => {
    expect(templateBillingMode(parseEventTemplatePayload({ audience: "CLUB" }))).toBe("DEFERRED_ORGANIZATION_INVOICE");
    expect(templateBillingMode(parseEventTemplatePayload({ audience: "GENERAL" }))).toBe("ATTENDEE_PAY");
    expect(templateBillingMode(parseEventTemplatePayload({ audience: "CLUB", billingMode: "ATTENDEE_PAY" }))).toBe("ATTENDEE_PAY");
  });

  it("uses the CLUB audience for the club events and GENERAL for the rest", () => {
    const audiences = Object.fromEntries(starterEventTemplates.map((starter) => [starter.name, starter.audience]));
    expect(audiences).toEqual({
      "Blank event": "GENERAL",
      "Blank club event": "CLUB",
      "Women's Retreat": "GENERAL",
      "Man Camp": "GENERAL",
      "Spring Camporee": "CLUB",
      "Fall Camporee": "CLUB",
      "Camp Meeting": "GENERAL",
      "Honors Weekend": "CLUB",
      "Pathfinder Leadership Weekend": "GENERAL",
      "TLT Retreat": "GENERAL",
      "Outdoor School": "GENERAL",
      "Hispanic Institute of Evangelism": "GENERAL",
    });
  });

  it("turns shirt sizes on only when the form asks for a shirt size", () => {
    for (const starter of starterEventTemplates) {
      const asksForShirt = fieldsOf(starter.formTemplateKey).some((field) => field.key === "shirt_size");
      expect(starter.collectsShirtSizes, starter.name).toBe(asksForShirt);
    }
  });

  it("turns adult Sterling Volunteers on for the club events only", () => {
    for (const starter of starterEventTemplates) {
      expect(starter.checksAdultBackgrounds, starter.name).toBe(starter.audience === "CLUB");
    }
  });

  it("describes itself as coming from the starter set and names its source form", () => {
    for (const starter of starterEventTemplates) {
      const description = starterDescription(starter);
      expect(description).toContain("Starter set");
      expect(description).toContain(starter.formTemplateKey);
      expect(description).toContain(getFormTemplate(starter.formTemplateKey)!.name);
    }
  });

  it("would fail reference validation if a starter named a missing form", () => {
    const broken = { ...starterPayload(starterEventTemplates[0]!), formTemplateKeys: ["no_such_form"] };
    expect(() => validateEventTemplatePayloadReferences(broken)).toThrow(EventTemplateReferenceError);
  });
});
