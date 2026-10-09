import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { ClassPickFields } from "@/components/class-pick-fields";
import { GroupRegistrationFlow } from "@/components/group-registration-flow";
import { PublicRegistrationForm } from "@/components/public-registration-form";
import { groupFormDefinition, groupPickingAttendee } from "@/modules/group-registrations/domain";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import type { PickingAttendee } from "@/modules/honors/registration-picks";

// Synthetic data only.
const field = (
  key: string,
  options: { type?: string; scope?: "ATTENDEE" | "REGISTRATION"; required?: boolean; optionSource?: string; priceCents?: number; label?: string } = {},
) => ({
  id: `f_${key}`, key, label: options.label ?? key, helpText: "", type: options.type ?? "TEXT",
  scope: options.scope ?? "REGISTRATION", required: options.required ?? false, options: [] as string[],
  ...(options.optionSource ? { optionSource: options.optionSource } : {}),
  ...(options.priceCents ? { priceCents: options.priceCents } : {}),
});

const clubDefinition = registrationFormDefinitionSchema.parse({
  title: "Synthetic weekend", description: "", confirmationMessage: "Received.",
  attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Person", addButtonLabel: "Add a person" },
  sections: [
    { id: "s_people", title: "People", description: "", fields: [
      field("first_name", { scope: "ATTENDEE", required: true }),
      field("last_name", { scope: "ATTENDEE", required: true }),
      field("attendee_age", { scope: "ATTENDEE", type: "NUMBER", required: true, label: "Age" }),
      field("registration_fee", { scope: "ATTENDEE", type: "CALCULATED", priceCents: 2500 }),
    ] },
    { id: "s_contact", title: "Contact", description: "", fields: [
      field("club_name", { type: "SELECT", required: true, optionSource: "CLUBS_DIRECTORY" }),
      field("email", { type: "EMAIL", required: true }),
    ] },
  ],
});
const groupDefinition = groupFormDefinition(clubDefinition);

const event = {
  name: "Synthetic Weekend", slug: "synthetic-weekend", startsAt: "2026-12-05T15:00:00.000Z", endsAt: "2026-12-06T22:00:00.000Z",
  timezone: "America/Chicago", location: null, capacity: null, billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const,
};
const lifecycle = { phase: "OPEN" as const, capacityDecision: "REGISTER" as const, remainingSpots: null, waitingRegistrations: 0 };
const form = { slug: "club:group", versionId: "v1", versionNumber: 1, definition: groupDefinition };

const offering = (id: string, honorName: string, extra: Record<string, unknown> = {}) => ({
  id, honorName, honorCode: id, span: "SINGLE_SESSION" as const, sessionId: "s1", sessionName: "Sabbath", sessionOrder: 0,
  siteId: null, siteName: null, capacity: 10, minimumAge: null, minimumClassLevel: null, prerequisiteHonors: [], perClubLimit: null, teacherName: "", location: "", isActive: true,
  seatsTaken: 0, clubSeatsTaken: 0, ...extra,
});

describe("the group's registration form (#650)", () => {
  const group = (extra: Record<string, unknown> = {}) => ({
    submitUrl: "/api/public/events/synthetic-weekend/group-registrations",
    locationId: "loc-1",
    honorSelections: {},
    billingNotice: "You'll be billed after the event.",
    ...extra,
  });
  const render = (groupProps: ReturnType<typeof group> | undefined, billingMode = event.billingMode) => renderToStaticMarkup(createElement(PublicRegistrationForm, {
    event: { ...event, billingMode },
    form, choiceUsage: {}, pricingDate: "2026-10-15", lifecycle, disableDrafts: true,
    ...(groupProps ? { group: groupProps } : {}),
  }));

  it("shows the price and an estimate with the billed-later notice, and no club or church question", () => {
    const markup = render(group({ locationName: "Camp Heritage" }));
    expect(markup).toContain("You&#x27;ll be billed after the event. No payment is due online.");
    expect(markup).toContain("Estimated total");
    expect(markup).toContain("$25");
    expect(markup).toContain("Camp Heritage");
    expect(markup).not.toContain("Your church is billed");
    expect(markup).not.toContain("Price per person");
    expect(markup).not.toContain("club_name");
    expect(markup).not.toContain("Club");
  });

  it("keeps a church-billed club registrant's per-person price, with no total", () => {
    const markup = render(undefined);
    expect(markup).toContain("$25 per person.");
    expect(markup).toContain("your church will be invoiced after the event based on confirmed attendance.");
    expect(markup).not.toContain("Estimated total");
  });

  it("puts each person's classes under their details, and says when the group will be waitlisted", () => {
    const markup = render(group({
      renderAttendeeExtras: (attendee: { clientId: string }) => createElement("p", null, `Classes for ${attendee.clientId}`),
      waitlistNote: "This location is full, so your group will join its waitlist.",
    }));
    expect(markup).toMatch(/Classes for [\w-]+/);
    expect(markup).toContain("join its waitlist");
  });
});

describe("a club's registration shows location and classes under each person too (C7, #650)", () => {
  it("renders the extras under each person's details, in the club's form", () => {
    const markup = renderToStaticMarkup(createElement(PublicRegistrationForm, {
      event, form: { ...form, definition: clubDefinition }, choiceUsage: {}, pricingDate: "2026-10-15", lifecycle,
      club: {
        initialAttendees: [
          { clientId: "member:m1", responses: { first_name: "Ada", last_name: "Demo", attendee_age: "12" } },
          { clientId: "member:m2", responses: { first_name: "Ben", last_name: "Demo", attendee_age: "14" } },
        ],
        lockedAttendeeFieldKeys: ["first_name", "last_name", "attendee_age"],
        submitUrl: "/api/attendee/clubs/club-1/events/event-1/registration",
        renderAttendeeExtras: (attendee: { clientId: string }) => createElement("p", null, `Location and classes for ${attendee.clientId}`),
      },
    }));
    expect(markup).toContain("Location and classes for member:m1");
    expect(markup).toContain("Location and classes for member:m2");
  });
});

describe("one person's class choices", () => {
  const catalogSessions = [{ id: "s1", name: "Sabbath", locationId: null, sortOrder: 0, createdAt: new Date("2026-10-01T00:00:00Z") }];
  const youth: PickingAttendee = { clientId: "p1", firstName: "Ada", lastName: "Demo", ageOnEventDate: 9, attendeeType: "YOUTH", consumesSeat: true };
  const renderPicks = (attendee: PickingAttendee, noun: "club" | "group") => renderToStaticMarkup(createElement(ClassPickFields, {
    attendee, noun, onChange: () => undefined, picks: [], sessions: catalogSessions,
    offerings: [
      offering("o-birds", "Birds", { perClubLimit: 2 }),
      offering("o-advanced", "Advanced Knots", { minimumAge: 12 }),
      offering("o-full", "Full Class", { capacity: 1, seatsTaken: 1 }),
    ],
  }));

  it("disables a class that is too advanced or full, and counts the per-group limit in the group's words", () => {
    const markup = renderPicks(youth, "group");
    expect(markup).toContain("Sabbath");
    expect(markup).toMatch(/<option[^>]*disabled[^>]*value="o-advanced"/);
    expect(markup).toContain("ages 12+");
    expect(markup).toMatch(/<option[^>]*disabled[^>]*value="o-full"/);
    expect(markup).toContain("left for your group");
    expect(markup).not.toContain("left for your club");
  });

  it("says club for a club's registration, and shows no seat count to an adult", () => {
    expect(renderPicks(youth, "club")).toContain("left for your club");
    const adult: PickingAttendee = { ...youth, ageOnEventDate: 40, attendeeType: "ADULT", consumesSeat: false };
    const markup = renderPicks(adult, "group");
    expect(markup).toContain("no seat needed");
    expect(markup).not.toMatch(/<option[^>]*disabled[^>]*value="o-full"/);
  });

  it("reads a person's name, age and seat rule from the answers they typed", () => {
    expect(groupPickingAttendee(groupDefinition, { clientId: "p1", responses: { first_name: "Ada", last_name: "Demo", attendee_age: "9" } }))
      .toEqual({ clientId: "p1", firstName: "Ada", lastName: "Demo", ageOnEventDate: 9, attendeeType: "YOUTH", consumesSeat: true });
    expect(groupPickingAttendee(groupDefinition, { clientId: "p2", responses: { first_name: "Ben", last_name: "Demo", attendee_age: "40" } }))
      .toMatchObject({ ageOnEventDate: 40, attendeeType: "ADULT", consumesSeat: false });
    // A corrected name is read from the answers, which is what a rename sends (#650).
    expect(groupPickingAttendee(groupDefinition, { clientId: "p1", responses: { first_name: " Adaline ", last_name: "Demo-Smith", attendee_age: "9" } }))
      .toMatchObject({ firstName: "Adaline", lastName: "Demo-Smith" });
    // No age yet: no type, so nothing about classes is decided.
    expect(groupPickingAttendee(groupDefinition, { clientId: "p3", responses: { first_name: "Cy", last_name: "Demo" } }))
      .toMatchObject({ ageOnEventDate: null, attendeeType: null });
  });
});

describe("the group page's first step", () => {
  const location = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, address: "1 Synthetic Rd", firstDay: "2026-12-05", lastDay: "2026-12-06", registrationClosesOn: "2026-11-30",
    ownClosingDate: null, full: false, waitlistOnFull: false, phase: "OPEN" as const, open: true, isActive: true, ...extra,
  });
  const ready = (locations: ReturnType<typeof location>[]) => ({
    event: { id: "e1", name: "Synthetic Weekend", slug: "synthetic-weekend", eventDate: "2026-12-05", phase: "OPEN" as const },
    problem: null,
    experience: {
      event, form: { slug: "club", versionId: "v1", versionNumber: 1, definition: groupDefinition }, choiceUsage: {},
      pricingDate: "2026-10-15", lifecycle,
    },
    locations,
    honorsCatalog: null,
    billingNotice: "You'll be billed after the event.",
  });
  const render = (locations: ReturnType<typeof location>[]) => renderToStaticMarkup(createElement(GroupRegistrationFlow, {
    eventSlug: "synthetic-weekend",
    ready: ready(locations) as never,
  }));

  it("asks for a location first, labelled only Group, with the billing words and no seat counts", () => {
    const markup = render([location("l1", "Camp Heritage"), location("l2", "Des Moines", { full: true })]);
    expect(markup).toContain("Register as a group or individual");
    expect(markup).toContain("Group registration");
    expect(markup.toLowerCase()).not.toContain("homeschool");
    expect(markup).toContain("Camp Heritage");
    expect(markup).toContain("Des Moines");
    expect(markup).toContain("You&#x27;ll be billed after the event.");
    expect(markup).toContain("Your group registers at one location");
    expect(markup).not.toMatch(/\d+ spots? left/);
    // A full location with no waitlist cannot be picked.
    expect(markup).toMatch(/<input[^>]*disabled[^>]*type="radio"/);
  });

  it("goes straight to the form when the event has no locations", () => {
    const markup = render([]);
    expect(markup).not.toContain("Register as a group or individual");
    expect(markup).toContain("Add another person");
  });
});
