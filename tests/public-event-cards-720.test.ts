import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventFindFirst: vi.fn(),
  attendeeCount: vi.fn(),
  getPublicEventLanding: vi.fn(),
  directedClubs: vi.fn(),
  redirect: vi.fn((path: string) => { throw new Error(`REDIRECT:${path}`); }),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    event: { findFirst: mocks.eventFindFirst },
    eventContentSection: { findMany: vi.fn().mockResolvedValue([]) },
    registrationAttendee: { count: mocks.attendeeCount },
  }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/modules/event-info-cards/repository", () => ({ getAutoEventInfoCards: vi.fn().mockResolvedValue(null) }));
vi.mock("@/modules/organizations/director-access", () => ({
  getDirectedClubsForCurrentAttendee: mocks.directedClubs,
}));

import { getFormTemplate, type RegistrationFormDefinition } from "@/modules/forms/definition";
import {
  duplicatePublicFormGroups,
  publicFormDifferentiators,
} from "@/modules/forms/duplicate-public-forms";
import { getDuplicatePublicFormWarnings } from "@/modules/events/readiness";
import { collectEventReadinessWarnings } from "@/modules/events/readiness-warnings";
import { clubRegistrationEntryPath } from "@/modules/club-registrations/entry-path";

function honorsDefinition(overrides: Partial<RegistrationFormDefinition> = {}): RegistrationFormDefinition {
  const template = getFormTemplate("honors_weekend");
  if (!template) throw new Error("honors_weekend template missing");
  return { ...structuredClone(template.definition), ...overrides };
}

function formRow(id: string, name: string, definition: RegistrationFormDefinition, createdAt: string, status = "PUBLISHED") {
  return {
    id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    createdAt: new Date(createdAt),
    versions: [{ id: `${id}-v1`, versionNumber: 1, status, definition }],
  };
}

function eventRow(forms: ReturnType<typeof formRow>[], overrides: Record<string, unknown> = {}) {
  return {
    id: "event-honors",
    slug: "honors-weekend-test",
    name: "Honors Weekend Test",
    startsAt: new Date("2027-03-12T22:00:00.000Z"),
    endsAt: new Date("2027-03-14T17:00:00.000Z"),
    timezone: "America/Chicago",
    location: "Fictitious Camp",
    capacity: 300,
    publicInfoUrl: null,
    supportContact: "events@example.test",
    audience: "CLUB",
    isPublished: true,
    registrationOpensOn: null,
    registrationClosesOn: null,
    waitlistEnabled: true,
    billingMode: "DEFERRED_ORGANIZATION_INVOICE",
    announcements: [],
    registrationForms: forms,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attendeeCount.mockResolvedValue(0);
});

describe("public event cards are distinguishable (#720)", () => {
  it("uses each form's own title and description, and no differentiator when they differ", async () => {
    const { getPublicEventLanding } = await import("@/modules/events/public-repository");
    const a = honorsDefinition({ title: "Honors Weekend registration", description: "For clubs sending honors teams." });
    const b = honorsDefinition({ title: "Honors Weekend volunteers", description: "" });
    mocks.eventFindFirst.mockResolvedValue(eventRow([
      formRow("f1", "Honors A", a, "2027-01-01"),
      formRow("f2", "Honors B", b, "2027-01-02"),
    ]));
    const landing = await getPublicEventLanding("honors-weekend-test");
    expect(landing?.forms.map((form) => form.title)).toEqual(["Honors Weekend registration", "Honors Weekend volunteers"]);
    expect(landing?.forms[0]?.description).toBe("For clubs sending honors teams.");
    expect(landing?.forms[1]?.description).toBe("Complete this form to register for the event.");
    expect(landing?.forms.map((form) => form.differentiator)).toEqual([null, null]);
  });

  it("gives three otherwise identical published forms three different neutral labels, never an id", async () => {
    const { getPublicEventLanding } = await import("@/modules/events/public-repository");
    const same = honorsDefinition({ title: "Honors Weekend registration", description: "Same text." });
    mocks.eventFindFirst.mockResolvedValue(eventRow([
      formRow("cuid-aaa", "Honors Weekend registration", same, "2027-01-01"),
      formRow("cuid-bbb", "Honors Weekend registration (copy)", same, "2027-01-02"),
      formRow("cuid-ccc", "Honors Weekend registration", same, "2027-01-03"),
    ]));
    const landing = await getPublicEventLanding("honors-weekend-test");
    const labels = landing!.forms.map((form) => form.differentiator);
    expect(labels).toEqual(["Option 1 of 3", "Form name: Honors Weekend registration (copy)", "Option 3 of 3"]);
    expect(new Set(labels).size).toBe(3);
    // A single rendering per form: three forms in, three cards out (no repeat of one form).
    expect(new Set(landing!.forms.map((form) => form.id)).size).toBe(3);
    expect(JSON.stringify(labels)).not.toContain("cuid-");
  });

  it("does not list an unpublished form among the cards", async () => {
    const { getPublicEventLanding } = await import("@/modules/events/public-repository");
    const def = honorsDefinition({ title: "Honors Weekend registration" });
    mocks.eventFindFirst.mockResolvedValue(eventRow([
      formRow("f1", "Honors A", def, "2027-01-01"),
      { ...formRow("f2", "Honors B", def, "2027-01-02"), versions: [] },
    ]));
    const landing = await getPublicEventLanding("honors-weekend-test");
    expect(landing?.forms).toHaveLength(1);
    expect(landing?.forms[0]?.differentiator).toBeNull();
  });

  it("renders the title, the differentiator, and the card note in the page", async () => {
    const { getPublicEventLanding } = await import("@/modules/events/public-repository");
    const same = honorsDefinition({ title: "Honors Weekend registration", description: "Same text." });
    mocks.eventFindFirst.mockResolvedValue(eventRow([
      formRow("f1", "Honors Weekend registration", same, "2027-01-01"),
      formRow("f2", "Honors Weekend registration", same, "2027-01-02"),
    ]));
    mocks.getPublicEventLanding.mockResolvedValue(await getPublicEventLanding("honors-weekend-test"));
    vi.doMock("@/modules/events/public-repository", () => ({ getPublicEventLanding: mocks.getPublicEventLanding }));
    vi.resetModules();
    const { default: Page } = await import("@/app/(public)/events/[eventSlug]/page");
    const markup = renderToStaticMarkup(await Page({ params: Promise.resolve({ eventSlug: "honors-weekend-test" }) }));
    expect(markup).toContain("Honors Weekend registration");
    expect(markup).toContain("Option 1 of 2");
    expect(markup).toContain("Option 2 of 2");
    expect(markup).toContain("For club directors. Sign in with your club account");
    vi.doUnmock("@/modules/events/public-repository");
    vi.resetModules();
  });
});

describe("club roster cards open club registration, not the anonymous form (#720)", () => {
  it("links each club roster card to the club entry and keeps non-roster and non-club links", async () => {
    const { getPublicEventLanding } = await import("@/modules/events/public-repository");
    const roster = honorsDefinition({ title: "Club roster registration" });
    const plain = honorsDefinition({ title: "Volunteer sign-up" });
    plain.attendeeRoster = undefined;
    mocks.eventFindFirst.mockResolvedValue(eventRow([
      formRow("f1", "club-roster", roster, "2027-01-01"),
      formRow("f2", "volunteer", plain, "2027-01-02"),
    ]));
    const club = await getPublicEventLanding("honors-weekend-test");
    expect(club?.forms.map((form) => [form.registrationPath, form.href])).toEqual([
      ["CLUB_PORTAL", "/account/club-registration/honors-weekend-test"],
      ["PUBLIC_FORM", "/register/honors-weekend-test/volunteer"],
    ]);

    mocks.eventFindFirst.mockResolvedValue(eventRow([
      formRow("f1", "club-roster", roster, "2027-01-01"),
    ], { audience: "GENERAL", billingMode: "ATTENDEE_PAY" }));
    const general = await getPublicEventLanding("honors-weekend-test");
    expect(general?.forms[0]).toMatchObject({ registrationPath: "PUBLIC_FORM", href: "/register/honors-weekend-test/club-roster" });
  });

  it("builds the entry path from the slug only", () => {
    expect(clubRegistrationEntryPath("honors weekend/2027")).toBe("/account/club-registration/honors%20weekend%2F2027");
  });

  describe("the club entry page", () => {
    async function entry() {
      return (await import("@/app/(public)/account/(portal)/club-registration/[eventSlug]/page")).default;
    }
    const event = { id: "event-honors", name: "Honors Weekend Test", slug: "honors-weekend-test" };

    it("sends a signed-in director to that club's registration for the event", async () => {
      mocks.eventFindFirst.mockResolvedValue(event);
      mocks.directedClubs.mockResolvedValue([{ organizationId: "club-1", name: "Test Club", role: "DIRECTOR", sponsoringChurch: null }]);
      const Page = await entry();
      await expect(Page({ params: Promise.resolve({ eventSlug: "honors-weekend-test" }) }))
        .rejects.toThrow("REDIRECT:/account/clubs/club-1/events/event-honors");
    });

    it("lets a visitor with several clubs choose, and tells a non-director why they cannot continue", async () => {
      mocks.eventFindFirst.mockResolvedValue(event);
      const Page = await entry();
      mocks.directedClubs.mockResolvedValue([
        { organizationId: "club-1", name: "Club One", role: "DIRECTOR", sponsoringChurch: null },
        { organizationId: "club-2", name: "Club Two", role: "REGISTRAR", sponsoringChurch: null },
        { organizationId: "club-3", name: "Reporter Only Club", role: "REPORTER", sponsoringChurch: null },
      ]);
      const many = renderToStaticMarkup(await Page({ params: Promise.resolve({ eventSlug: "honors-weekend-test" }) }));
      expect(many).toContain("/account/clubs/club-1/events/event-honors");
      expect(many).toContain("/account/clubs/club-2/events/event-honors");
      expect(many).not.toContain("club-3");

      mocks.directedClubs.mockResolvedValue([]);
      const none = renderToStaticMarkup(await Page({ params: Promise.resolve({ eventSlug: "honors-weekend-test" }) }));
      expect(none).toContain("for club directors, deputies, and registrars");
    });

    it("is not found for an event that is not a published church-billed club event", async () => {
      mocks.eventFindFirst.mockResolvedValue(null);
      const Page = await entry();
      await expect(Page({ params: Promise.resolve({ eventSlug: "nope" }) })).rejects.toThrow("NOT_FOUND");
      expect(mocks.eventFindFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", isPublished: true }),
      }));
    });

    it("sits under the account portal layout, which sends signed-out visitors to sign-in and back", () => {
      const layout = readFileSync("app/(public)/account/(portal)/layout.tsx", "utf8");
      expect(layout).toContain("attendeeSignInRedirectPath");
      expect(layout).toContain("if (!account && !acting) redirect(await attendeeSignInRedirectPath())");
    });
  });
});

describe("duplicate published form detection (#720)", () => {
  const same = { title: "Honors Weekend registration", description: "Same." };

  it("groups published forms sharing a title and description, ignoring case and spacing", () => {
    const groups = duplicatePublicFormGroups([
      { id: "a", ...same },
      { id: "b", title: "  honors weekend  REGISTRATION ", description: "same." },
      { id: "c", title: "Other", description: "Same." },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((form) => form.id)).toEqual(["a", "b"]);
  });

  it("warns with the staff text for duplicates and not for a single or distinct forms", () => {
    expect(getDuplicatePublicFormWarnings([same, same], "event-1")).toEqual([
      expect.objectContaining({ detail: "Two forms look the same to the public. Rename one or unpublish it." }),
    ]);
    expect(getDuplicatePublicFormWarnings([same])).toEqual([]);
    expect(getDuplicatePublicFormWarnings([same, { ...same, description: "Different." }])).toEqual([]);
  });

  function prismaWith(forms: { id: string; definitions: { status: string; definition: RegistrationFormDefinition }[] }[]) {
    const published = (form: (typeof forms)[number]) => form.definitions.filter((v) => v.status === "PUBLISHED").slice(0, 1).map((v) => ({ definition: v.definition }));
    return {
      eventLocation: { findMany: vi.fn().mockResolvedValue([]) },
      registrationForm: {
        findMany: vi.fn()
          .mockResolvedValueOnce(forms.map((form) => ({ id: form.id, versions: published(form) })))
          .mockResolvedValueOnce(forms.map((form) => ({ id: form.id, versions: form.definitions.slice(0, 1).map((v) => ({ definition: v.definition })) }))),
      },
    };
  }

  it("fires on the readiness checks for two published duplicates", async () => {
    const def = honorsDefinition({ title: "Honors Weekend registration", description: "Same." });
    const prisma = prismaWith([
      { id: "f1", definitions: [{ status: "PUBLISHED", definition: def }] },
      { id: "f2", definitions: [{ status: "PUBLISHED", definition: def }] },
    ]);
    const warnings = await collectEventReadinessWarnings(prisma as never, "event-1", "DEFERRED_ORGANIZATION_INVOICE");
    expect(warnings.filter((warning) => warning.id.startsWith("duplicate-public-forms:"))).toHaveLength(1);
  });

  it("does not fire when the twin is only a draft", async () => {
    const def = honorsDefinition({ title: "Honors Weekend registration", description: "Same." });
    const prisma = prismaWith([
      { id: "f1", definitions: [{ status: "PUBLISHED", definition: def }] },
      { id: "f2", definitions: [{ status: "DRAFT", definition: def }] },
    ]);
    const warnings = await collectEventReadinessWarnings(prisma as never, "event-1", "DEFERRED_ORGANIZATION_INVOICE");
    expect(warnings.filter((warning) => warning.id.startsWith("duplicate-public-forms:"))).toHaveLength(0);
  });

  it("labels identical cards from their internal name when it is unique, else their place", () => {
    const base = { title: "T", description: "D", audienceLabel: "A", highlights: ["x"] };
    expect(publicFormDifferentiators([
      { ...base, name: "T" },
      { ...base, name: "Second copy" },
    ])).toEqual(["Option 1 of 2", "Form name: Second copy"]);
    expect(publicFormDifferentiators([{ ...base, name: "T" }, { ...base, highlights: ["y"], name: "T" }])).toEqual([null, null]);
  });
});

describe("builder warning (#720)", () => {
  it("renders the duplicate warning from the shared message", () => {
    const source = readFileSync("components/registration-builder-workspace.tsx", "utf8");
    expect(source).toContain("duplicatePublicFormGroups(forms.flatMap");
    expect(source).toContain('version.status === "PUBLISHED"');
    expect(source).toContain("{DUPLICATE_PUBLIC_FORMS_MESSAGE}");
  });
});

describe("public event page layout classes (#720)", () => {
  const css = readFileSync("app/globals.css", "utf8");
  const page = readFileSync("app/(public)/events/[eventSlug]/page.tsx", "utf8");

  it("wraps every content section in one shared container", () => {
    const containerStart = page.indexOf('<div className="public-event-container">');
    expect(containerStart).toBeGreaterThan(0);
    for (const marker of ["<EventInfoCards", "public-event-resources", "public-event-layout", "public-event-sidebar", "public-event-announcement-feed", "<AutoEventInfoCards"]) {
      expect(page.indexOf(marker, containerStart)).toBeGreaterThan(containerStart);
    }
  });

  it("gives the container a 1180px max width and 16px gutters, and zeroes the sections' own side margins", () => {
    expect(css).toMatch(/\.public-event-container\s*\{[^}]*width:\s*min\(100% - 32px, 1180px\);[^}]*margin-inline:\s*auto;/);
    const reset = css.match(/\.public-event-container > \.public-registration-hero,[\s\S]*?\{([^}]*)\}/);
    expect(reset?.[1]).toMatch(/max-width:\s*none/);
    expect(reset?.[1]).toMatch(/margin-right:\s*0/);
    expect(reset?.[1]).toMatch(/margin-left:\s*0/);
    for (const section of [".event-info-cards", ".public-event-resources", ".public-event-layout", ".public-event-announcement-feed", ".auto-info-cards", ".auto-info-header"]) {
      expect(reset ? css.includes(`.public-event-container > ${section}`) : false).toBe(true);
    }
  });
});
