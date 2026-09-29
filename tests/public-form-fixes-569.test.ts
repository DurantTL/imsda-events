import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicEventSlugNotFound } from "@/components/public-event-slug-not-found";
import { defaultTypeForNewChoiceField } from "@/modules/forms/choice-defaults";
import {
  dateFieldBounds,
  dateFieldProblem,
  isBirthDateField,
  numberFieldBounds,
  registrationFormDefinitionSchema,
  validateTestResponses,
  type RegistrationFormField,
} from "@/modules/forms/definition";
import { readFileSync } from "node:fs";
import { preparePublicRegistration } from "@/modules/forms/public-domain";
import { planAttendeeRemoval, withoutAttendee } from "@/modules/forms/attendee-removal";
import { PublicRegistrationForm } from "@/components/public-registration-form";
import { prepareTieredAttendeeAnswerUpdate } from "@/modules/attendee-accounts/registration-answer-policy";

const now = new Date("2026-09-29T12:00:00Z");
const dateField = { type: "DATE", key: "birth_date", label: "Birth date" } as const;
const idempotencyKey = "9f8f0f3a-4c73-4d7e-89a4-f54d4fe0c388";

describe("FB-5 date bounds (#569)", () => {
  it("rejects years before 1900 for any date field", () => {
    expect(dateFieldProblem({ type: "DATE", key: "arrival", label: "Arrival" }, "1899-12-31", now)).toMatch(/before 1900/);
    expect(dateFieldProblem({ type: "DATE", key: "arrival", label: "Arrival" }, "1900-01-01", now)).toBeNull();
    expect(dateFieldProblem({ type: "DATE", key: "arrival", label: "Arrival" }, "2030-01-01", now)).toBeNull();
  });
  it("rejects future birthdates but allows today", () => {
    expect(isBirthDateField(dateField)).toBe(true);
    expect(dateFieldProblem(dateField, "2026-09-30", now)).toMatch(/future/);
    expect(dateFieldProblem(dateField, "2026-09-29", now)).toBeNull();
  });
  it("gives the input min and max", () => {
    expect(dateFieldBounds(dateField, now)).toEqual({ min: "1900-01-01", max: "2026-09-29" });
    expect(dateFieldBounds({ type: "DATE", key: "arrival", label: "Arrival" }, now).max).toBeUndefined();
  });
  it("is enforced by the shared server validation", () => {
    const definition = registrationFormDefinitionSchema.parse({
      title: "Date bounds check", description: "Synthetic form.", confirmationMessage: "Received.",
      sections: [{ id: "details", title: "Details", description: "", fields: [
        { id: "birth_field", key: "birth_date", label: "Birth date", type: "DATE", scope: "REGISTRATION", required: true, helpText: "", options: [] },
      ] }],
    });
    const issues = (value: string) => validateTestResponses(definition, { birth_date: value }).issues ?? [];
    expect(issues("1850-01-01").length).toBeGreaterThan(0);
    expect(issues("2999-01-01").length).toBeGreaterThan(0);
    expect(issues("2010-05-05")).toEqual([]);
  });
});

describe("FB-5 numeric min/max (#569)", () => {
  it("honors builder min/max on a non-age number and caps an unset maximum", () => {
    const field = { key: "tickets", ageBounds: { minimumAge: 2, maximumAge: null } } as Pick<RegistrationFormField, "key" | "ageBounds">;
    expect(numberFieldBounds(field)).toEqual({ minimumAge: 2, maximumAge: 100000 });
  });
  it("builder exposes minimum and maximum inputs", () => {
    const src = readFileSync("components/registration-builder-workspace.tsx", "utf8");
    expect(src).toContain("Minimum value for");
    expect(src).toContain("Maximum value for");
  });
});

describe("FB-9 new choice fields (#569)", () => {
  it("defaults a new short dropdown to radio cards, keeps long lists and existing choice fields", () => {
    expect(defaultTypeForNewChoiceField("TEXT", "SELECT", 2)).toBe("RADIO");
    expect(defaultTypeForNewChoiceField("TEXT", "SELECT", 6)).toBe("RADIO");
    expect(defaultTypeForNewChoiceField("TEXT", "SELECT", 7)).toBe("SELECT");
    expect(defaultTypeForNewChoiceField("RADIO", "SELECT", 3)).toBe("SELECT");
    expect(defaultTypeForNewChoiceField("TEXT", "MULTISELECT", 3)).toBe("MULTISELECT");
  });
});

describe("unknown event slug page (#569)", () => {
  it("names the slug and links to the public event list", () => {
    const html = renderToStaticMarkup(createElement(PublicEventSlugNotFound, { slug: "no-such-event" }));
    expect(html).toContain("Event not found");
    expect(html).toContain("no-such-event");
    expect(html).toContain("https://imsda.org/events/");
    expect(html).toContain("IMSDA");
  });
});

describe("birth date detection uses keys, never labels (#569)", () => {
  it("does not treat an 'Expected birth date' due-date field as a birth date", () => {
    const due = { type: "DATE", key: "due_date", label: "Expected birth date" } as const;
    expect(isBirthDateField(due)).toBe(false);
    expect(dateFieldProblem(due, "2027-01-15", now)).toBeNull();
    expect(dateFieldBounds(due, now).max).toBeUndefined();
  });
  it("recognizes the explicit birth-date keys", () => {
    for (const key of ["birth_date", "date_of_birth", "dob", "birthdate"]) {
      expect(isBirthDateField({ type: "DATE", key })).toBe(true);
    }
  });
  it("uses the Chicago calendar date, not UTC", () => {
    expect(dateFieldBounds(dateField, new Date("2026-09-30T02:00:00Z")).max).toBe("2026-09-29");
  });
});

function testDefinition(fields: unknown[]) {
  return registrationFormDefinitionSchema.parse({
    title: "Synthetic retreat form", description: "Synthetic.", confirmationMessage: "Received.",
    sections: [{ id: "details", title: "Details", description: "", fields }],
  });
}
const base = { helpText: "", options: [] as string[] };

describe("FB-5 through preparePublicRegistration (#569)", () => {
  const definition = testDefinition([
    { ...base, id: "name_field", key: "contact_name", label: "Contact name", type: "TEXT", scope: "REGISTRATION", required: true },
    { ...base, id: "email_field", key: "email", label: "Email", type: "EMAIL", scope: "REGISTRATION", required: true },
    { ...base, id: "birth_field", key: "birth_date", label: "Birth date", type: "DATE", scope: "REGISTRATION", required: true },
  ]);
  const run = (birth: string) => preparePublicRegistration(
    definition,
    { versionId: "version-1", idempotencyKey, responses: { contact_name: "Avery Guest", email: "guest@example.test", birth_date: birth }, attendees: [], website: "" },
    { timeZone: "America/Chicago", now },
  );
  it("rejects a pre-1900 and a future birth date, accepts a normal one", () => {
    expect(run("1850-03-04").isValid).toBe(false);
    expect(run("2027-03-04").isValid).toBe(false);
    expect(run("1990-03-04").issues).toEqual([]);
  });
});

describe("FB-9 leaves loaded fields alone (#569)", () => {
  it("keeps a published SELECT with few choices as SELECT", () => {
    const definition = testDefinition([
      { ...base, id: "shirt_field", key: "shirt", label: "Shirt", type: "SELECT", scope: "REGISTRATION", required: false, options: ["S", "M", "L"] },
    ]);
    expect(definition.sections[0].fields[0].type).toBe("SELECT");
  });
});

describe("attendee removal plan (F-13, #569)", () => {
  const people = [
    { clientId: "a", name: "Avery", answers: true },
    { clientId: "b", name: "Blake", answers: true },
    { clientId: "c", name: "Casey", answers: false },
  ];
  const has = (person: (typeof people)[number]) => person.answers;
  it("asks before discarding answers, and skips the prompt for an empty attendee", () => {
    expect(planAttendeeRemoval(people, "a", 1, has)).toBe("confirm");
    expect(planAttendeeRemoval(people, "c", 1, has)).toBe("remove");
  });
  it("never goes below the minimum", () => {
    expect(planAttendeeRemoval(people.slice(0, 1), "a", 1, has)).toBe("blocked");
  });
  it("Cancel keeps everyone: nothing changes until the plan is carried out", () => {
    const before = [...people];
    planAttendeeRemoval(people, "a", 1, has);
    expect(people).toEqual(before);
  });
  it("removes the confirmed attendee by id even after a reorder", () => {
    const reordered = [people[2], people[1], people[0]];
    expect(withoutAttendee(reordered, "b").map((p) => p.clientId)).toEqual(["c", "a"]);
  });
});

describe("required checkbox markup (F-18, #569)", () => {
  const definition = testDefinition([
    { ...base, id: "ack_field", key: "deposit_ack", label: "I acknowledge the deposit", type: "CHECKBOX", scope: "REGISTRATION", required: true },
    { ...base, id: "opt_field", key: "newsletter", label: "Send me news", type: "CHECKBOX", scope: "REGISTRATION", required: false },
  ]);
  const html = renderToStaticMarkup(createElement(PublicRegistrationForm, {
    event: { name: "Synthetic Retreat", slug: "synthetic-retreat", startsAt: "2026-10-09T00:00:00.000Z", endsAt: "2026-10-11T00:00:00.000Z", timezone: "America/Chicago", location: null, capacity: null, billingMode: "ATTENDEE_PAY" },
    form: { slug: "main", versionId: "version-1", versionNumber: 1, definition },
    choiceUsage: {},
    pricingDate: "2026-09-29",
    lifecycle: { phase: "OPEN", capacityDecision: "REGISTER", remainingSpots: null, waitingRegistrations: 0 },
  }));
  it("marks only the required checkbox required and aria-required", () => {
    const checkboxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(checkboxes.length).toBeGreaterThanOrEqual(2);
    const required = checkboxes.filter((tag) => /\brequired=""/.test(tag));
    expect(required).toHaveLength(1);
    expect(required[0]).toContain('aria-required="true"');
  });
});

describe("self-service edits with an old bad date (#569)", () => {
  const definition = testDefinition([
    { ...base, id: "first_field", key: "first_name", label: "First name", type: "TEXT", scope: "ATTENDEE", required: true },
    { ...base, id: "birth_field", key: "birth_date", label: "Birth date", type: "DATE", scope: "ATTENDEE", required: false },
    { ...base, id: "shirt_field", key: "shirt_size", label: "Shirt size", type: "SELECT", scope: "ATTENDEE", required: true, options: ["S", "M", "L"] },
  ]);
  it("still lets the attendee change another field", () => {
    const result = prepareTieredAttendeeAnswerUpdate({
      definition,
      policy: "TIERED",
      registrationResponses: {},
      currentResponses: { first_name: "Avery", birth_date: "1850-01-01", shirt_size: "M" },
      changes: { shirt_size: "L" },
    });
    expect(result.responses.shirt_size).toBe("L");
  });
});
