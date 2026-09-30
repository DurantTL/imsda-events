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
    startsAt: new Date("2026-11-06T15:00:00Z"), endsAt: new Date("2026-11-08T18:00:00Z"), timezone: "America/Chicago",
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
      "Additional cost (paid separately): $5.00",
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

  it("lists every site's dates and deadline, inheriting the event's where a site sets none", () => {
    expect(buildDatesCard(input)!.rows.map((row) => [row.name, row.dates])).toEqual([
      ["Site A", "Nov 6 – Nov 8, 2026"],
      ["Site B", "Nov 13 – Nov 14, 2026"],
      // Site C sets no dates, so it shows the event's.
      ["Site C", "Nov 6 – Nov 8, 2026"],
    ]);
    // The event has no deadline, so Site C has none and is left out.
    expect(buildDeadlinesCard(input)!.rows.map((row) => [row.name, row.deadline])).toEqual([
      ["Site A", "Oct 23, 2026"],
      ["Site B", "Nov 1, 2026"],
    ]);
    expect(buildDatesCard({ ...input, locations: [] })).toBeNull();
    expect(buildDeadlinesCard({ ...input, locations: [] })).toBeNull();
  });

  it("keeps the cards when every site inherits the event's dates and deadline", () => {
    const inherit = (id: string, name: string) => ({ id, name, address: null, firstDay: null, lastDay: null, registrationClosesOn: null, sortOrder: 0 });
    const all = { ...input, locations: [inherit("l1", "Site One"), inherit("l2", "Site Two")], event: { ...input.event, registrationClosesOn: "2026-10-30" } };
    expect(buildDatesCard(all)!.rows.map((row) => row.dates)).toEqual(["Nov 6 – Nov 8, 2026", "Nov 6 – Nov 8, 2026"]);
    expect(buildDeadlinesCard(all)!.rows.map((row) => row.deadline)).toEqual(["Oct 30, 2026", "Oct 30, 2026"]);
  });

  it("shows the event start through a site's last day when only the last day is set", () => {
    const lastOnly = { ...input, locations: [{ id: "l1", name: "Site One", address: null, firstDay: null, lastDay: "2026-11-07", registrationClosesOn: null, sortOrder: 0 }] };
    expect(buildDatesCard(lastOnly)!.rows[0]!.dates).toBe("Nov 6 – Nov 7, 2026");
  });

  it("falls back to the event deadline when there are no locations", () => {
    const rows = buildDeadlinesCard({ ...input, locations: [], event: { ...input.event, registrationClosesOn: "2026-10-30" } })!.rows;
    expect(rows).toEqual([{ id: "event", name: "Synthetic Honors Weekend", deadline: "Oct 30, 2026" }]);
  });

  it("builds fees with early and late tiers, attendee-type prices and billing notes", () => {
    const card = buildFeesCard(input)!;
    const groups = card.sections[0]!.groups;
    const fees = groups.find((group) => group.title === "Fees")!;
    expect(fees.lines).toEqual([{
      label: "Registration fee",
      unit: "per person",
      tiers: [
        { amountCents: 2500, note: "through Oct 15, 2026" },
        { amountCents: 3500, note: "from Oct 16, 2026" },
      ],
    }]);
    const types = groups.find((group) => group.title === "Attendee type")!;
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

describe("event info card edge cases", () => {
  const feeForm = (fields: unknown[], title = "Club registration") => ({
    title,
    definition: registrationFormDefinitionSchema.parse({
      title: "Synthetic form",
      description: "",
      confirmationMessage: "Thank you for registering.",
      sections: [{ id: "sec-fees", title: "Fees", description: "", fields }],
    }),
  });

  it("shows one undated tier when a choice has no late price", () => {
    const form = feeForm([{
      id: "fld-a", key: "lodging", label: "Lodging", type: "SELECT", scope: "ATTENDEE", required: true,
      options: ["Tent", "Cabin", "Child"],
      choicePricesCents: { Tent: 2500, Cabin: 3500, Child: 2500 },
      latePricing: { startsOn: "2026-08-24", label: "Regular", choicePricesCents: { Tent: 3500, Cabin: 4500 } },
    }]);
    const lines = buildFeesCard({ ...input, forms: [form] })!.sections[0]!.groups[0]!.lines;
    expect(lines.find((line) => line.label === "Tent")!.tiers).toEqual([
      { amountCents: 2500, note: "through Aug 23, 2026" },
      { amountCents: 3500, note: "from Aug 24, 2026" },
    ]);
    // The engine charges the regular price when a late one is missing.
    expect(lines.find((line) => line.label === "Child")!.tiers).toEqual([{ amountCents: 2500, note: null }]);
  });

  it("shows one undated tier when a single price has no late price", () => {
    const form = feeForm([{
      id: "fld-a", key: "registration_fee", label: "Registration fee", type: "CALCULATED", scope: "ATTENDEE", required: false,
      priceCents: 900, latePricing: { startsOn: "2026-08-24", label: "Late" },
    }]);
    expect(buildFeesCard({ ...input, forms: [form] })!.sections[0]!.groups[0]!.lines[0]!.tiers).toEqual([{ amountCents: 900, note: null }]);
  });

  describe("shows only what the engine charges", () => {
    const field = (extra: Record<string, unknown>) => ({
      id: "fld-a", key: "registration_fee", label: "Registration fee", type: "CALCULATED", scope: "ATTENDEE", required: false, ...extra,
    });
    const tiers = (extra: Record<string, unknown>) => buildFeesCard({ ...input, forms: [feeForm([field(extra)])] })?.sections[0]?.groups[0]?.lines[0]?.tiers;

    it("omits the tier a late empty choice map would charge as $0", () => {
      // From the late date the engine is in choice mode with an empty map: $0.
      expect(tiers({ priceCents: 900, latePricing: { startsOn: "2026-08-24", label: "Late", priceCents: 1400, choicePricesCents: {} } }))
        .toEqual([{ amountCents: 900, note: "through Aug 23, 2026" }]);
    });

    it("shows no price for an empty choice map on the field, which charges $0 throughout", () => {
      expect(tiers({ priceCents: 900, choicePricesCents: {} })).toBeUndefined();
    });

    it("shows the field price then the late option price for a late-only non-empty choice map", () => {
      expect(tiers({ priceCents: 900, options: ["A"], latePricing: { startsOn: "2026-08-24", label: "Late", choicePricesCents: { A: 1500 } } }))
        .toEqual([{ amountCents: 900, note: "through Aug 23, 2026" }, { amountCents: 1500, note: "from Aug 24, 2026" }]);
    });

    it("adds a No charge tier before the date for an option priced only late", () => {
      const form = feeForm([{
        id: "fld-a", key: "lodging", label: "Lodging", type: "SELECT", scope: "ATTENDEE", required: true,
        options: ["Tent", "Cabin"], choicePricesCents: { Tent: 2500 },
        latePricing: { startsOn: "2026-08-24", label: "Late", choicePricesCents: { Cabin: 4500 } },
      }]);
      const lines = buildFeesCard({ ...input, forms: [form] })!.sections[0]!.groups[0]!.lines;
      expect(lines.find((line) => line.label === "Cabin")!.tiers).toEqual([
        { amountCents: 0, note: "through Aug 23, 2026" },
        { amountCents: 4500, note: "from Aug 24, 2026" },
      ]);
    });
  });

  it("groups fees per form, by form name, when several forms are published", () => {
    const fee = (amount: number) => [{ id: "fld-a", key: "registration_fee", label: "Fee", type: "CALCULATED", scope: "ATTENDEE", required: false, priceCents: amount }];
    const card = buildFeesCard({ ...input, forms: [feeForm(fee(900), "Form One"), feeForm(fee(1200), "Form Two")] })!;
    expect(card.sections.map((section) => section.title)).toEqual(["Form One", "Form Two"]);
    expect(buildFeesCard({ ...input, forms: [feeForm(fee(900), "Form One")] })!.sections[0]!.title).toBeNull();
  });

  it("drops classes at inactive sites and keeps site-less classes under Other classes", () => {
    const card = buildClassGridsCard({
      ...input,
      inactiveLocationIds: ["l-b"],
      offerings: [
        offering({ id: "a", honorName: "Active", sessionId: "s-a1" }),
        offering({ id: "b", honorName: "Retired", sessionId: "s-b1" }),
        offering({ id: "c", honorName: "Retired all", span: "ALL_SESSIONS", sessionId: null, locationId: "l-b" }),
        offering({ id: "d", honorName: "Siteless", span: "ALL_SESSIONS", sessionId: null, locationId: null }),
      ],
    })!;
    const names = card.grids.flatMap((grid) => grid.sessions.flatMap((session) => session.classes.map((entry) => entry.honorName)));
    expect(names.sort()).toEqual(["Active", "Siteless"]);
    expect(card.grids.map((grid) => grid.locationName)).toEqual(["Site A", "Other classes"]);
  });

  it("calls a class limited only against a standard capacity shared by two classes, per site", () => {
    const two = (capacity: number, id: string) => offering({ id, capacity, honorName: id, sessionId: "s-a1" });
    const limited = (offerings: InfoCardOffering[]) => buildClassGridsCard({ ...input, offerings })!.grids[0]!.sessions[0]!.classes.filter((entry) => entry.kind === "LIMITED").length;
    expect(limited([two(15, "x"), two(15, "y"), two(8, "z")])).toBe(1);
    // All different: no standard, so nothing is limited.
    expect(limited([two(15, "x"), two(12, "y"), two(8, "z")])).toBe(0);
    // Site B's standard is its own; Site A's 30-seat classes don't make B's 15 limited.
    const mixed = buildClassGridsCard({ ...input, offerings: [
      offering({ id: "a1", capacity: 30, sessionId: "s-a1" }), offering({ id: "a2", capacity: 30, sessionId: "s-a1" }),
      offering({ id: "b1", capacity: 15, sessionId: "s-b1" }), offering({ id: "b2", capacity: 15, sessionId: "s-b1" }),
    ] })!;
    expect(mixed.grids.flatMap((grid) => grid.sessions.flatMap((session) => session.classes)).every((entry) => entry.kind === "STANDARD")).toBe(true);
  });

  it("shows a zero-seat class as No youth seats", () => {
    const entry = buildClassGridsCard({ ...input, offerings: [offering({ id: "z", capacity: 0, sessionId: "s-a1" })] })!.grids[0]!.sessions[0]!.classes[0]!;
    expect(entry.badges).toEqual([{ kind: "LIMITED", text: "No youth seats" }]);
  });
});
