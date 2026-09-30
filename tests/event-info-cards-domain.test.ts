import { describe, expect, it } from "vitest";
import {
  buildClassGridsCard,
  buildDatesCard,
  buildDeadlinesCard,
  buildEventInfoCards,
  buildFeesCard,
  buildHeaderCard,
  buildHelpCard,
  buildRegisterStepsCard,
  type InfoCardOffering,
  type InfoCardsInput,
} from "@/modules/event-info-cards/domain";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

const definition = registrationFormDefinitionSchema.parse({
  title: "Honors Weekend club registration",
  description: "",
  confirmationMessage: "Thank you for registering.",
  sections: [
    {
      id: "club-contact",
      title: "Club contact",
      description: "Tell us who is leading your club.",
      fields: [
        { id: "fld-1", key: "contact_name", label: "Contact name", type: "TEXT", scope: "REGISTRATION", required: true },
      ],
    },
    {
      id: "fees",
      title: "Fees and lodging",
      description: "",
      fields: [
        {
          id: "fld-2", key: "registration_fee", label: "Registration fee", type: "CALCULATED", scope: "ATTENDEE", required: false,
          priceCents: 2500, latePricing: { startsOn: "2026-10-16", label: "Late", priceCents: 3500 },
        },
        {
          id: "fld-3", key: "attendee_type", label: "Attendee type", type: "SELECT", scope: "ATTENDEE", required: true,
          options: ["Participant", "Non-participating adult"],
          choicePricesCents: { Participant: 2500, "Non-participating adult": 1500 },
        },
        { id: "fld-4", key: "credit", label: "Early credit", type: "NUMBER", scope: "REGISTRATION", required: false, creditCentsPerUnit: -500 },
      ],
    },
  ],
});

const offering = (overrides: Partial<InfoCardOffering> & { id: string }): InfoCardOffering => ({
  honorName: "Synthetic Honor",
  teacherName: "",
  capacity: 15,
  minimumAge: null,
  perClubLimit: null,
  additionalCostCents: null,
  requirementNote: "",
  span: "SINGLE_SESSION",
  sessionId: "s-a1",
  locationId: null,
  ...overrides,
});

const input: InfoCardsInput = {
  event: {
    name: "Synthetic Honors Weekend",
    location: "Iowa and Missouri",
    dateLabel: "Nov 6 – 8, 2026",
    tagline: "Lest We Forget",
    subtitle: "Register all of your club's attendees using only one form",
    helpEmail: null,
    audience: "CLUB",
    billingMode: "DEFERRED_ORGANIZATION_INVOICE",
    registrationClosesOn: null,
  },
  locations: [
    { id: "l-b", name: "Site B", address: "2 Synthetic Way", firstDay: "2026-11-13", lastDay: "2026-11-14", registrationClosesOn: "2026-11-01", sortOrder: 1 },
    { id: "l-a", name: "Site A", address: "1 Synthetic Road", firstDay: "2026-11-06", lastDay: "2026-11-08", registrationClosesOn: "2026-10-23", sortOrder: 0 },
    { id: "l-c", name: "Site C", address: null, firstDay: null, lastDay: null, registrationClosesOn: null, sortOrder: 2 },
  ],
  sessions: [
    { id: "s-a2", name: "Session 2 (11:00 AM)", locationId: "l-a", sortOrder: 1 },
    { id: "s-a1", name: "Session 1 (9:00 AM)", locationId: "l-a", sortOrder: 0 },
    { id: "s-b1", name: "Session 1 (9:00 AM)", locationId: "l-b", sortOrder: 0 },
  ],
  offerings: [
    offering({ id: "o1", honorName: "Zebras", sessionId: "s-a1" }),
    offering({ id: "o2", honorName: "Birds", sessionId: "s-a1", capacity: 8 }),
    offering({ id: "o3", honorName: "Knots", sessionId: "s-a2", minimumAge: 10, additionalCostCents: 500, requirementNote: "Bring a flashlight" }),
    offering({ id: "o4", honorName: "Ferns", sessionId: "s-b1", teacherName: "Synthetic Teacher" }),
    offering({ id: "o5", honorName: "Flags", span: "ALL_SESSIONS", sessionId: null, locationId: "l-b" }),
  ],
  forms: [{ title: "Club registration", definition }],
};

describe("event info card builders", () => {
  it("builds the header from event fields", () => {
    expect(buildHeaderCard(input)).toEqual({
      eyebrow: "Iowa-Missouri Conference of Seventh-day Adventists",
      title: "Synthetic Honors Weekend",
      tagline: "Lest We Forget",
      meta: "Iowa and Missouri · Nov 6 – 8, 2026",
      subtitle: "Register all of your club's attendees using only one form",
    });
    const bare = buildHeaderCard({ ...input, event: { ...input.event, tagline: " ", subtitle: null, location: null } });
    expect(bare.tagline).toBeNull();
    expect(bare.subtitle).toBeNull();
    expect(bare.meta).toBe("Nov 6 – 8, 2026");
  });

  it("groups classes per location then session with the session time as the header", () => {
    const card = buildClassGridsCard(input)!;
    expect(card.grids.map((grid) => grid.locationName)).toEqual(["Site A", "Site B"]);
    const [siteA, siteB] = card.grids;
    expect(siteA.sessions.map((session) => session.title)).toEqual(["Session 1 (9:00 AM)", "Session 2 (11:00 AM)"]);
    expect(siteA.sessions[0].classes.map((entry) => entry.honorName)).toEqual(["Birds", "Zebras"]);
    // The all-sessions class heads its site's grid.
    expect(siteB.sessions.map((session) => session.title)).toEqual(["All sessions", "Session 1 (9:00 AM)"]);
    expect(siteB.sessions[1].classes[0].teacherName).toBe("Synthetic Teacher");
  });

  it("marks classes with text badges as well as a colour kind", () => {
    const card = buildClassGridsCard(input)!;
    const entries = card.grids.flatMap((grid) => grid.sessions.flatMap((session) => session.classes));
    const byName = Object.fromEntries(entries.map((entry) => [entry.honorName, entry]));
    expect(byName.Zebras.kind).toBe("STANDARD");
    expect(byName.Zebras.badges).toEqual([]);
    expect(byName.Birds.badges).toEqual([{ kind: "LIMITED", text: "Limited spots: 8" }]);
    expect(byName.Knots.badges.map((badge) => badge.text)).toEqual([
      "Ages 10 and up",
      "Additional cost: $5.00",
      "Requirement: Bring a flashlight",
    ]);
    expect(byName.Knots.kind).toBe("SPECIAL");
    expect(card.legend.map((item) => item.label)).toEqual(["Standard", "Limited spots", "Age requirement", "Additional cost", "Special requirement"]);
  });

  it("puts a class without a known site in its own grid and hides an empty card", () => {
    const orphan = buildClassGridsCard({ ...input, offerings: [offering({ id: "x", span: "ALL_SESSIONS", sessionId: null, locationId: "gone" })] })!;
    expect(orphan.grids).toHaveLength(1);
    expect(orphan.grids[0].locationName).toBe("Other classes");
    expect(buildClassGridsCard({ ...input, offerings: [] })).toBeNull();
  });

  it("lists dates and deadlines by location in order, skipping locations without them", () => {
    expect(buildDatesCard(input)!.rows.map((row) => [row.name, row.dates])).toEqual([
      ["Site A", "Nov 6 – Nov 8, 2026"],
      ["Site B", "Nov 13 – Nov 14, 2026"],
    ]);
    expect(buildDeadlinesCard(input)!.rows.map((row) => [row.name, row.deadline])).toEqual([
      ["Site A", "Oct 23, 2026"],
      ["Site B", "Nov 1, 2026"],
    ]);
    expect(buildDatesCard({ ...input, locations: [] })).toBeNull();
    expect(buildDeadlinesCard({ ...input, locations: [] })).toBeNull();
  });

  it("falls back to the event deadline when there are no locations", () => {
    const rows = buildDeadlinesCard({ ...input, locations: [], event: { ...input.event, registrationClosesOn: "2026-10-30" } })!.rows;
    expect(rows).toEqual([{ id: "event", name: "Synthetic Honors Weekend", deadline: "Oct 30, 2026" }]);
  });

  it("builds fees with early and late tiers, attendee-type prices and billing notes", () => {
    const card = buildFeesCard(input)!;
    const fees = card.groups.find((group) => group.title === "Fees")!;
    expect(fees.lines).toEqual([{
      label: "Registration fee",
      unit: "per person",
      tiers: [
        { amountCents: 2500, note: "through Oct 15, 2026" },
        { amountCents: 3500, note: "from Oct 16, 2026" },
      ],
    }]);
    const types = card.groups.find((group) => group.title === "Attendee type")!;
    expect(types.lines.map((line) => [line.label, line.tiers[0].amountCents])).toEqual([
      ["Participant", 2500],
      ["Non-participating adult", 1500],
    ]);
    // A credit is not a fee.
    expect(JSON.stringify(card)).not.toContain("Early credit");
    expect(card.notes).toEqual(["Billed to your church", "Billed after the event"]);
  });

  it("omits billing notes for attendee-pay events and hides the card with no priced field", () => {
    const attendeePay = buildFeesCard({ ...input, event: { ...input.event, billingMode: "ATTENDEE_PAY" } })!;
    expect(attendeePay.notes).toEqual([]);
    expect(buildFeesCard({ ...input, forms: [] })).toBeNull();
  });

  it("generates registration steps from the real flow", () => {
    const card = buildRegisterStepsCard(input)!;
    expect(card.forms).toHaveLength(1);
    expect(card.forms[0].title).toBeNull();
    const titles = card.forms[0].steps.map((step) => step.title);
    expect(titles.slice(0, 2)).toEqual(["Club contact", "Fees and lodging"]);
    expect(titles.at(-1)).toMatch(/^Review/);
    expect(buildRegisterStepsCard({ ...input, forms: [] })).toBeNull();
  });

  it("uses the event help email, else youth@imsda.org for club events only", () => {
    expect(buildHelpCard(input)).toEqual({ email: "youth@imsda.org" });
    expect(buildHelpCard({ ...input, event: { ...input.event, helpEmail: "help@example.test" } })).toEqual({ email: "help@example.test" });
    expect(buildHelpCard({ ...input, event: { ...input.event, audience: "GENERAL" } })).toBeNull();
  });

  it("keeps markup as inert text", () => {
    const hostile = buildHeaderCard({ ...input, event: { ...input.event, tagline: "<script>alert(1)</script>" } });
    expect(hostile.tagline).toBe("<script>alert(1)</script>");
  });

  it("returns every card together and only the header for an empty event", () => {
    const all = buildEventInfoCards(input);
    expect(all.classes && all.dates && all.deadlines && all.fees && all.steps && all.help).toBeTruthy();
    const empty = buildEventInfoCards({ ...input, locations: [], sessions: [], offerings: [], forms: [], event: { ...input.event, audience: "GENERAL" } });
    expect(empty).toMatchObject({ classes: null, dates: null, deadlines: null, fees: null, steps: null, help: null });
  });
});
