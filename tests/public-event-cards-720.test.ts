import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventFindFirst: vi.fn(),
  attendeeCount: vi.fn(),
  getPublicEventLanding: vi.fn(),
  directedClubs: vi.fn(),
  currentAttendee: vi.fn(),
  needsSecondStep: vi.fn(),
  acting: vi.fn(),
  formFindFirst: vi.fn(),
  redirect: vi.fn((path: string) => { throw new Error(`REDIRECT:${path}`); }),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    event: { findFirst: mocks.eventFindFirst },
    eventContentSection: { findMany: vi.fn().mockResolvedValue([]) },
    registrationAttendee: { count: mocks.attendeeCount },
    registrationForm: { findFirst: mocks.formFindFirst },
  }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/modules/event-info-cards/repository", () => ({ getAutoEventInfoCards: vi.fn().mockResolvedValue(null) }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.directedClubs }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.currentAttendee }));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: mocks.needsSecondStep }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.acting }));
vi.mock("@/modules/attendee-accounts/return-redirect", () => ({
  attendeeSignInRedirectPath: async () => "/account/sign-in?next=%2Fx",
  twoStepRedirectPath: async () => "/account/two-step?next=%2Fx",
}));

import { getFormTemplate, type RegistrationFormDefinition } from "@/modules/forms/definition";
import {
  duplicatePublicFormGroups,
  publicFormDifferentiators,
} from "@/modules/forms/duplicate-public-forms";
import { getDuplicatePublicFormWarnings } from "@/modules/events/readiness";
import { collectEventReadinessWarnings } from "@/modules/events/readiness-warnings";
import { clubFormProblem } from "@/modules/club-registrations/domain";
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
  mocks.currentAttendee.mockResolvedValue({ account: { id: "acct-1" }, via: "attendee", sessionId: "sess-1" });
  mocks.needsSecondStep.mockResolvedValue("OK");
  mocks.acting.mockResolvedValue(null);
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
  const rosterDef = () => honorsDefinition({ title: "Club roster registration" });
  const plainDef = () => { const d = honorsDefinition({ title: "Volunteer sign-up" }); d.attendeeRoster = undefined; return d; };
  const paths = (landing: { forms: { slug: string; registrationPath: string; href: string }[] } | null) =>
    landing?.forms.map((form) => [form.slug, form.registrationPath, form.href]);

  it("gives the portal link to the single form the portal serves", async () => {
    const { getPublicEventLanding } = await import("@/modules/events/public-repository");
    mocks.eventFindFirst.mockResolvedValue(eventRow([formRow("f1", "club-roster", rosterDef(), "2027-01-01")]));
    expect(paths(await getPublicEventLanding("honors-weekend-test"))).toEqual([
      ["club-roster", "CLUB_PORTAL", "/account/club-registration/honors-weekend-test"],
    ]);
  });

  it("with two roster forms, only the oldest opens the portal; the other keeps its public link", async () => {
    const { getPublicEventLanding } = await import("@/modules/events/public-repository");
    mocks.eventFindFirst.mockResolvedValue(eventRow([
      formRow("f2", "a-newer", rosterDef(), "2027-02-01"),
      formRow("f1", "b-oldest", rosterDef(), "2027-01-01"),
    ]));
    expect(paths(await getPublicEventLanding("honors-weekend-test"))).toEqual([
      ["a-newer", "PUBLIC_FORM", "/register/honors-weekend-test/a-newer"],
      ["b-oldest", "CLUB_PORTAL", "/account/club-registration/honors-weekend-test"],
    ]);
  });

  it("with a non-roster oldest form, no card opens the portal", async () => {
    const { getPublicEventLanding } = await import("@/modules/events/public-repository");
    mocks.eventFindFirst.mockResolvedValue(eventRow([
      formRow("f1", "volunteer", plainDef(), "2027-01-01"),
      formRow("f2", "club-roster", rosterDef(), "2027-02-01"),
    ]));
    expect(paths(await getPublicEventLanding("honors-weekend-test"))).toEqual([
      ["volunteer", "PUBLIC_FORM", "/register/honors-weekend-test/volunteer"],
      ["club-roster", "PUBLIC_FORM", "/register/honors-weekend-test/club-roster"],
    ]);
  });

  it("when the portal would reject the oldest roster form (clubFormProblem), it keeps its public link", async () => {
    const { getPublicEventLanding } = await import("@/modules/events/public-repository");
    const rejected = rosterDef();
    rejected.sections[0]!.fields[0]!.label = "Birth date";
    expect(clubFormProblem(rejected)).not.toBeNull();
    mocks.eventFindFirst.mockResolvedValue(eventRow([formRow("f1", "club-roster", rejected, "2027-01-01")]));
    expect(paths(await getPublicEventLanding("honors-weekend-test"))).toEqual([
      ["club-roster", "PUBLIC_FORM", "/register/honors-weekend-test/club-roster"],
    ]);
  });

  it("the landing page and the portal pick the same form, including when createdAt ties", async () => {
    const { getPublicEventLanding } = await import("@/modules/events/public-repository");
    const { publishedClubForm } = await import("@/modules/club-registrations/repository");
    const tie = "2027-01-01T00:00:00.000Z";
    const rows = [
      formRow("id-b", "form-b", rosterDef(), tie),
      formRow("id-a", "form-a", rosterDef(), tie),
      formRow("id-c", "form-c", rosterDef(), "2026-12-31T00:00:00.000Z"),
    ];
    // The mocked query honours the orderBy it is given: createdAt, then id.
    const portalQuery = (order: typeof rows) => {
      mocks.eventFindFirst.mockResolvedValue(eventRow(order));
      mocks.formFindFirst.mockImplementation(async (args: { orderBy: { createdAt?: string; id?: string }[] }) => {
        expect(args.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
        const first = [...order].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0]!;
        return { id: first.id, slug: first.slug, createdAt: first.createdAt, versions: [{ definition: first.versions[0]!.definition }] };
      });
    };
    const cardSlugs = async () =>
      (await getPublicEventLanding("honors-weekend-test"))!.forms.filter((form) => form.registrationPath === "CLUB_PORTAL").map((form) => form.slug);
    for (const order of [rows, [...rows].reverse()]) {
      portalQuery(order);
      expect(await cardSlugs()).toEqual(["form-c"]);
      expect((await publishedClubForm("event-honors"))?.slug).toBe("form-c");
    }
    // Tie only: the lower id wins on both sides, whatever the input order.
    const tied = rows.slice(0, 2);
    for (const order of [tied, [...tied].reverse()]) {
      portalQuery(order);
      expect(await cardSlugs()).toEqual(["form-a"]);
      expect((await publishedClubForm("event-honors"))?.slug).toBe("form-a");
    }
  });

  it("keeps public links on a general or attendee-pay event", async () => {
    const { getPublicEventLanding } = await import("@/modules/events/public-repository");
    mocks.eventFindFirst.mockResolvedValue(eventRow([formRow("f1", "club-roster", rosterDef(), "2027-01-01")], { audience: "GENERAL", billingMode: "ATTENDEE_PAY" }));
    expect(paths(await getPublicEventLanding("honors-weekend-test"))).toEqual([
      ["club-roster", "PUBLIC_FORM", "/register/honors-weekend-test/club-roster"],
    ]);
  });

  it("shows the club-directors note only on the portal card", async () => {
    const { getPublicEventLanding } = await import("@/modules/events/public-repository");
    mocks.eventFindFirst.mockResolvedValue(eventRow([
      formRow("f1", "oldest", rosterDef(), "2027-01-01"),
      formRow("f2", "newer", honorsDefinition({ title: "Other roster" }), "2027-02-01"),
    ]));
    mocks.getPublicEventLanding.mockResolvedValue(await getPublicEventLanding("honors-weekend-test"));
    vi.doMock("@/modules/events/public-repository", () => ({ getPublicEventLanding: mocks.getPublicEventLanding }));
    vi.resetModules();
    const { default: Page } = await import("@/app/(public)/events/[eventSlug]/page");
    const markup = renderToStaticMarkup(await Page({ params: Promise.resolve({ eventSlug: "honors-weekend-test" }) }));
    expect(markup.split("For club directors. Sign in with your club account").length - 1).toBe(1);
    vi.doUnmock("@/modules/events/public-repository");
    vi.resetModules();
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

    it("redirects a signed-out visitor to sign-in without relying on the layout", async () => {
      mocks.eventFindFirst.mockResolvedValue(event);
      mocks.currentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
      const Page = await entry();
      await expect(Page({ params: Promise.resolve({ eventSlug: "honors-weekend-test" }) }))
        .rejects.toThrow("REDIRECT:/account/sign-in?next=%2Fx");
    });

    it("redirects to the two-step page when the second step is pending", async () => {
      mocks.eventFindFirst.mockResolvedValue(event);
      mocks.needsSecondStep.mockResolvedValue("VERIFY");
      const Page = await entry();
      await expect(Page({ params: Promise.resolve({ eventSlug: "honors-weekend-test" }) }))
        .rejects.toThrow("REDIRECT:/account/two-step?next=%2Fx");
      expect(mocks.directedClubs).not.toHaveBeenCalled();
    });

    it("sends staff acting as a club director to that club's registration", async () => {
      mocks.eventFindFirst.mockResolvedValue(event);
      mocks.acting.mockResolvedValue({ role: "CLUB_DIRECTOR", organizationId: "club-act", userId: "u1" });
      mocks.currentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
      const Page = await entry();
      await expect(Page({ params: Promise.resolve({ eventSlug: "honors-weekend-test" }) }))
        .rejects.toThrow("REDIRECT:/account/clubs/club-act/events/event-honors");
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
  async function renderBuilder(statuses: string[]) {
    const { createElement } = await import("react");
    const { RegistrationBuilderWorkspace } = await import("@/components/registration-builder-workspace");
    const definition = honorsDefinition({ title: "Honors Weekend registration", description: "Same." });
    const forms = statuses.map((status, index) => {
      const version = {
        id: `v${index}`, versionNumber: 1, status, definition: structuredClone(definition),
        publishedAt: status === "PUBLISHED" ? "2028-08-01T00:00:00.000Z" : null,
        createdAt: "2028-08-01T00:00:00.000Z", updatedAt: "2028-08-01T00:00:00.000Z", createdBy: "Synthetic Staff",
        testSubmissionCount: 0, choiceUsage: {}, testSubmissions: [],
      };
      return {
        id: `form-${index}`, eventId: "event-1", name: `Copy ${index + 1}`, slug: `copy-${index + 1}`, status,
        createdAt: "2028-08-01T00:00:00.000Z", updatedAt: "2028-08-01T00:00:00.000Z", createdBy: "Synthetic Staff",
        activeVersion: version, versions: [version],
      };
    });
    return renderToStaticMarkup(createElement(RegistrationBuilderWorkspace, {
      eventId: "event-1", eventSlug: "honors-test", eventName: "Honors Test", initialForms: forms, templates: [],
    }));
  }

  it("shows for two published duplicates", async () => {
    const markup = await renderBuilder(["PUBLISHED", "PUBLISHED"]);
    expect(markup).toContain('data-testid="duplicate-public-forms-warning"');
    expect(markup).toContain("Two forms look the same to the public. Rename one or unpublish it.");
    expect(markup).toContain("Copy 1, Copy 2");
  });

  it("is hidden when one of the two is only a draft", async () => {
    const markup = await renderBuilder(["PUBLISHED", "DRAFT"]);
    expect(markup).not.toContain("duplicate-public-forms-warning");
    expect(markup).not.toContain("look the same to the public");
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
