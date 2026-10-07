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

const wantedNames = ["Blank event", "Blank club event", "Women's Retreat", "Man Camp", "Spring Camporee", "Fall Camporee", "Camp Meeting", "Pathfinder Bible Experience", "Honors Weekend", "Pathfinder Leadership Weekend", "TLT Retreat", "Outdoor School", "Hispanic Institute of Evangelism"];

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
    // The Pathfinder Bible Experience (#809) also carries its team rules and registration deadline.
    expect(Object.keys(payload).filter((key) => !["locations", "teamSettings", "registrationClosesOn"].includes(key)).sort()).toEqual([
      "attendeeClassifications", "attendeeTypes", "audience", "billingMode", "brandingDefaults", "formTemplateKeys",
      "messageTemplateDefaults", "moduleEnablement", "reportSelections", "starterKey",
    ]);
    expect("locations" in payload).toBe(["fall_camporee", "pathfinder_bible_experience"].includes(starter.starterKey));
    expect("teamSettings" in payload).toBe(starter.starterKey === "pathfinder_bible_experience");
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
      "Pathfinder Bible Experience": "CLUB",
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

  describe("Pathfinder Bible Experience (#809)", () => {
    const starter = starterEventTemplates.find((entry) => entry.starterKey === "pathfinder_bible_experience")!;
    const payload = parseEventTemplatePayload(starterPayload(starter));

    it("presets every rule Caleb recorded: teams, size 2 to 7, one alternate, age on 2026-01-01 up to 19", () => {
      expect(payload.teamSettings).toMatchObject({
        allowMultipleTeams: true, minTeamMembers: 2, maxTeamMembers: 7, maxAlternates: 1, ageAsOf: "2026-01-01", maxMemberAge: 19,
        booksLine: "The Book of Mark, 1-2 Peter, 1-3 John & Commentary",
      });
    });

    it("carries the Conference and Union dates, the deadline, the two sites with the venue unknown, and church billing", () => {
      expect(payload.teamSettings?.levelInfo).toEqual([
        { level: "CONFERENCE", date: "2027-02-20", place: "TBA" },
        { level: "UNION", date: "2027-03-27", place: "Lincoln, NE" },
      ]);
      expect(payload.registrationClosesOn).toBe("2026-12-18");
      expect(payload.locations?.map((location) => [location.name, location.address])).toEqual([["Missouri", null], ["Iowa", null]]);
      expect(payload.audience).toBe("CLUB");
      expect(payload.billingMode).toBe("DEFERRED_ORGANIZATION_INVOICE");
      expect(payload.moduleEnablement.checksAdultBackgrounds).toBe(true);
    });

    it("is a free form: no fee, price or payment anywhere in it", () => {
      const definition = getFormTemplate("pbe_registration")!.definition;
      expect(JSON.stringify(definition)).not.toMatch(/priceCents|choicePricesCents|creditCentsPerUnit|"payment"/);
    });

    it("asks for the coordinator, partner club, alternate, coach role, confirmation and release", () => {
      const keys = fieldsOf("pbe_registration").map((field) => `${field.scope}:${field.key}`);
      for (const key of [
        "REGISTRATION:coordinator_name", "REGISTRATION:coordinator_address", "REGISTRATION:coordinator_city", "REGISTRATION:coordinator_state",
        "REGISTRATION:coordinator_zip", "REGISTRATION:coordinator_phone", "REGISTRATION:coordinator_email", "REGISTRATION:partner_club",
        "REGISTRATION:director_confirmation", "REGISTRATION:photo_video_release", "ATTENDEE:alternate", "ATTENDEE:attendee_type", "ATTENDEE:attendee_age",
      ]) expect(keys).toContain(key);
      const role = fieldsOf("pbe_registration").find((field) => field.key === "attendee_type")!;
      expect(role.options).toEqual(["Pathfinder", "TLT", "Coach"]);
    });

    it("is refused for a general event, since team rules are for club events", () => {
      expect(() => parseEventTemplatePayload({ ...starterPayload(starter), audience: "GENERAL" })).toThrow(EventTemplateReferenceError);
    });
  });
});
