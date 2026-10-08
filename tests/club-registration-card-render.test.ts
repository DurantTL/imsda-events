import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { PublicRegistrationForm } from "@/components/public-registration-form";
import type { AttentionItem } from "@/modules/club-registrations/attention";
import { rosterAnsweredFieldKeys } from "@/modules/club-registrations/domain";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

// Synthetic data only.
const field = (key: string, label: string, type = "TEXT", options: string[] = []) => ({
  id: `f_${key}`, key, label, helpText: "", type, scope: "ATTENDEE" as const, required: true, options,
});

const definition = registrationFormDefinitionSchema.parse({
  title: "Synthetic weekend", description: "", confirmationMessage: "Received.",
  attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Person", addButtonLabel: "Add a person" },
  sections: [{ id: "s_people", title: "People", description: "", fields: [
    field("first_name", "First name zz"),
    field("last_name", "Last name zz"),
    field("attendee_age", "Age zz", "NUMBER"),
    field("gender", "Gender zz", "SELECT", ["Female", "Male"]),
    field("attendee_type", "Role zz", "SELECT", ["Pathfinder", "Staff"]),
  ] }],
});

const event = {
  name: "Synthetic Weekend", slug: "synthetic-weekend", startsAt: "2026-12-05T15:00:00.000Z", endsAt: "2026-12-06T22:00:00.000Z",
  timezone: "America/Chicago", location: null, capacity: null, billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const,
};
const lifecycle = { phase: "OPEN" as const, capacityDecision: "REGISTER" as const, remainingSpots: null, waitingRegistrations: 0 };
const form = { slug: "club:test", versionId: "v1", versionNumber: 1, definition };

const known = { first_name: "Ada", last_name: "Demo", attendee_age: "12", gender: "Female", attendee_type: "Pathfinder" };
const rosterValues = { gender: "Female", attendee_type: "Pathfinder" };
const people = (extra: Record<string, unknown> = {}) => [
  { clientId: "member:m1", responses: { ...known }, carriedFromRoster: true, rosterValues, ...extra },
  { clientId: "member:m2", responses: { ...known, first_name: "Ben" }, carriedFromRoster: true, rosterValues, ...extra },
];

function renderClub(attendees: ReturnType<typeof people>, club: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(PublicRegistrationForm, {
    event, form, choiceUsage: {}, pricingDate: "2026-10-15", lifecycle, disableDrafts: true,
    club: {
      initialAttendees: attendees,
      lockedAttendeeFieldKeys: ["first_name", "last_name", "attendee_age"],
      submitUrl: "/api/attendee/clubs/club-1/events/event-1/registration",
      ...club,
    },
  } as never));
}

describe("roster answers on a club card (#853)", () => {
  it("hides name and age, and tucks gender and role behind Change while they match the roster", () => {
    const markup = renderClub(people());
    expect(markup).not.toContain("First name zz");
    expect(markup).not.toContain("Age zz");
    expect(markup).not.toContain("Gender zz");
    expect(markup).not.toContain("Role zz");
    expect(markup).toContain("From your roster, not asked again: age 12, Female, Pathfinder.");
    expect(markup).toContain('aria-label="Change gender or role for Ada Demo"');
  });

  it("asks gender and role when the held value differs from the roster's", () => {
    const markup = renderClub([{ clientId: "member:m1", responses: { ...known, attendee_type: "Staff" }, carriedFromRoster: true, rosterValues }]);
    expect(markup).toContain("Gender zz");
    expect(markup).toContain("Role zz");
    expect(markup).not.toContain("Change gender or role");
  });

  it("asks them in the editor path (reopening a submitted registration)", () => {
    const markup = renderClub(people(), { submitEdit: async () => ({ ok: true as const }) });
    expect(markup).toContain("Gender zz");
    expect(markup).toContain("Role zz");
    expect(markup).not.toContain("Change gender or role");
  });

  it("still asks a value the roster lacks", () => {
    const markup = renderClub([{ clientId: "member:m1", responses: { ...known, attendee_age: "" }, carriedFromRoster: true, rosterValues }]);
    expect(markup).toContain("Age zz");
  });

  it("keeps the pure rule: name and age locked, gender and role changeable", () => {
    expect(rosterAnsweredFieldKeys(definition, known, { carriedFromRoster: true, rosterValues })).toEqual({
      locked: ["first_name", "last_name", "attendee_age"],
      changeable: ["gender", "attendee_type"],
    });
    expect(rosterAnsweredFieldKeys(definition, known, { carriedFromRoster: true, rosterValues, askChangeable: true }).changeable).toEqual([]);
    expect(rosterAnsweredFieldKeys(definition, known, { carriedFromRoster: false, rosterValues }).changeable).toEqual([]);
  });
});

describe("the attention list on a card (#853)", () => {
  const needsCheck = (): AttentionItem[] => [{ reason: "Background check needed", fix: "Ask them to complete a Sterling Volunteers check." }];
  const expiring = (): AttentionItem[] => [{ reason: "Background check expiring soon", fix: "Ask them to renew.", advisory: true }];

  it("names the reason on a collapsed club card, and takes Complete away", () => {
    const markup = renderClub(people(), { attendeeAttention: needsCheck });
    expect(markup).toContain("Background check needed.");
    expect(markup).toContain("needs-attention");
    expect(markup).not.toContain("status-complete");
  });

  it("shows an expiring check as a note and keeps Complete", () => {
    const markup = renderClub(people(), { attendeeAttention: expiring });
    expect(markup).toContain("Background check expiring soon.");
    expect(markup).toContain("status-complete");
    expect(markup).not.toContain("needs-attention");
  });

  it("shows no attention list on a form that is not a club registration", () => {
    const markup = renderToStaticMarkup(createElement(PublicRegistrationForm, {
      event, form, choiceUsage: {}, pricingDate: "2026-10-15", lifecycle, disableDrafts: true,
    } as never));
    expect(markup).not.toContain("public-registration-attendee-attention");
    expect(markup).not.toContain("Answer needed");
  });
});
