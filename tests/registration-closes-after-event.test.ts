import { beforeEach, describe, expect, it, vi } from "vitest";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  refreshBackgroundChecks: vi.fn(),
  requirePermission: vi.fn(),
  getCurrentSession: vi.fn(),
  findActiveMembership: vi.fn(),
  publishEvent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/background-checks/refresh-after-write", () => ({
  refreshBackgroundCheckMatchesForRegistrations: dependencies.refreshBackgroundChecks,
}));
vi.mock("@/modules/access/authorization", () => ({
  requirePermission: dependencies.requirePermission,
  AccessDeniedError: class AccessDeniedError extends Error {},
}));
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: dependencies.getCurrentSession,
}));
vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: dependencies.findActiveMembership,
  publishEvent: dependencies.publishEvent,
  EventOperationError: class EventOperationError extends Error {},
}));

import { POST as PUBLISH } from "@/app/api/events/[eventId]/publish/route";
import {
  evaluateEventRegistrationPhase,
  hasEventEnded,
} from "@/modules/events/lifecycle";
import { describePublicEventLifecycle } from "@/modules/events/public-domain";
import {
  getEventPublishWarnings,
  pastEventPublishWarning,
} from "@/modules/events/readiness";
import {
  getPublicPromoCodeQuote,
  PublicPromoCodeError,
} from "@/modules/promo-codes/repository";
import { submitPublicRegistration } from "@/modules/forms/public-repository";
import { createRegistration } from "@/modules/registrations/repository";

// A Central-time event whose last day is Sunday 2026-10-11 (ends 5pm CDT).
const event = {
  isPublished: true,
  timezone: "America/Chicago",
  registrationOpensOn: null,
  registrationClosesOn: null,
  waitlistEnabled: false,
  capacity: null,
  endsAt: new Date("2026-10-11T22:00:00.000Z"),
};
const lastDayStart = new Date("2026-10-11T05:00:00.000Z");
const lastDayEnd = new Date("2026-10-12T04:59:59.999Z");
const nextDayStart = new Date("2026-10-12T05:00:00.000Z");

describe("registration closes once the event has ended (#575)", () => {
  it("stays open before and throughout the last day in the event time zone", () => {
    expect(evaluateEventRegistrationPhase(event, new Date("2026-09-29T12:00:00.000Z"))).toBe("OPEN");
    expect(evaluateEventRegistrationPhase(event, new Date("2026-10-10T12:00:00.000Z"))).toBe("OPEN");
    expect(evaluateEventRegistrationPhase(event, lastDayStart)).toBe("OPEN");
    // Well after the event's end instant but still the same local calendar day.
    expect(evaluateEventRegistrationPhase(event, new Date("2026-10-12T02:00:00.000Z"))).toBe("OPEN");
    expect(evaluateEventRegistrationPhase(event, lastDayEnd)).toBe("OPEN");
    expect(hasEventEnded(event, lastDayEnd)).toBe(false);
  });

  it("closes at local midnight after the last day, even with a later closing date", () => {
    expect(evaluateEventRegistrationPhase(event, nextDayStart)).toBe("CLOSED");
    expect(evaluateEventRegistrationPhase(
      { ...event, registrationClosesOn: "2026-12-31" },
      new Date("2026-11-01T12:00:00.000Z"),
    )).toBe("CLOSED");
    expect(hasEventEnded(event, nextDayStart)).toBe(true);
  });

  it("still respects an earlier registration window and unpublished drafts", () => {
    expect(evaluateEventRegistrationPhase(
      { ...event, registrationClosesOn: "2026-10-01" },
      new Date("2026-10-05T12:00:00.000Z"),
    )).toBe("CLOSED");
    expect(evaluateEventRegistrationPhase(
      { ...event, isPublished: false },
      nextDayStart,
    )).toBe("DRAFT");
  });

  it("leaves an event without an end date to the registration window alone", () => {
    const withoutEnd = { ...event, endsAt: undefined };
    expect(evaluateEventRegistrationPhase(withoutEnd, nextDayStart)).toBe("OPEN");
  });

  it("shows the closed message on the public landing and offers no call to action", () => {
    const open = describePublicEventLifecycle(event, 0, lastDayEnd);
    expect(open).toMatchObject({ state: "OPEN", ctaEnabled: true });

    const closed = describePublicEventLifecycle(event, 0, nextDayStart);
    expect(closed).toMatchObject({
      state: "CLOSED",
      statusLabel: "Registration for this event has closed.",
      ctaEnabled: false,
    });
  });
});

const definition = registrationFormDefinitionSchema.parse({
  title: "Closed form",
  description: "",
  confirmationMessage: "Saved.",
  sections: [{
    id: "registration",
    title: "Registration",
    description: "",
    fields: [
      { id: "name", key: "full_name", label: "Full name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
      { id: "promo", key: "promo_code", label: "Promo code", helpText: "", type: "TEXT", scope: "REGISTRATION", required: false, options: [] },
    ],
  }],
});

function formRow() {
  return {
    id: "form_1",
    slug: "registration",
    eventId: "event_1",
    event: {
      id: "event_1",
      name: "Synthetic Retreat",
      slug: "synthetic-retreat",
      startsAt: new Date("2026-10-09T14:00:00.000Z"),
      ...event,
      location: "Camp",
      billingMode: "ATTENDEE_PAY",
      audience: "GENERAL",
      attendeeTypes: [],
    },
    versions: [{
      id: "version_1",
      versionNumber: 1,
      definition,
      publishedAt: new Date("2026-06-01T12:00:00.000Z"),
    }],
  };
}

const submission = publicRegistrationInputSchema.parse({
  versionId: "version_1",
  idempotencyKey: "42c8575a-a024-48cb-978d-90c64d9152e6",
  responses: { full_name: "Closed Tester", promo_code: "" },
  website: "",
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("server-side enforcement", () => {
  it("refuses a public submission after the last day with REGISTRATION_CLOSED", async () => {
    const tx = {
      registrationForm: { findFirst: vi.fn().mockResolvedValue(formRow()) },
      publicRegistrationSubmission: { findUnique: vi.fn().mockResolvedValue(null) },
      registration: { create: vi.fn() },
    };
    dependencies.getPrisma.mockReturnValue({
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    });

    await expect(
      submitPublicRegistration("synthetic-retreat", "registration", submission, nextDayStart),
    ).rejects.toMatchObject({
      code: "REGISTRATION_CLOSED",
      message: "Registration for this event has closed.",
    });
    expect(tx.registration.create).not.toHaveBeenCalled();
  });

  it("refuses a promo quote after the last day but not on it", async () => {
    const findFirst = vi.fn().mockResolvedValue(formRow());
    dependencies.getPrisma.mockReturnValue({ registrationForm: { findFirst } });
    const quoteInput = {
      versionId: "version_1",
      code: "SAVE10",
      responses: { full_name: "Closed Tester" },
      attendees: undefined,
    } as Parameters<typeof getPublicPromoCodeQuote>[2];

    await expect(
      getPublicPromoCodeQuote("synthetic-retreat", "registration", quoteInput, nextDayStart),
    ).rejects.toMatchObject({
      reason: "REGISTRATION_CLOSED",
      message: "Registration for this event has closed.",
    });
    await expect(
      getPublicPromoCodeQuote("synthetic-retreat", "registration", quoteInput, nextDayStart),
    ).rejects.toBeInstanceOf(PublicPromoCodeError);

    // On the last day the closed check does not fire; the call proceeds to
    // later work (which this minimal mock cannot finish) instead.
    await getPublicPromoCodeQuote("synthetic-retreat", "registration", quoteInput, lastDayEnd)
      .catch((error: unknown) => {
        expect((error as { reason?: string }).reason).not.toBe("REGISTRATION_CLOSED");
      });
  });

  it("lets staff still add a registration after the event has ended", async () => {
    const eventLookup = vi.fn();
    const tx = {
      person: { create: vi.fn().mockResolvedValue({ id: "person_1" }) },
      registration: { create: vi.fn().mockResolvedValue({ id: "registration_1" }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      event: { findUnique: eventLookup },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
      registration: { findMany: vi.fn().mockResolvedValue([]) },
    };
    dependencies.getPrisma.mockReturnValue(prisma);
    dependencies.refreshBackgroundChecks.mockResolvedValue(undefined);

    await createRegistration("event_1", {
      firstName: "Staff",
      lastName: "Added",
      email: "",
      phone: "",
      attendeeType: "ATTENDEE",
      status: "CONFIRMED",
      totalAmountCents: 0,
    }, "user_1").catch(() => undefined);

    // The write went through; nothing consulted event dates or a phase.
    expect(tx.registration.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(eventLookup).not.toHaveBeenCalled();
  });
});

describe("publish warning", () => {
  it("warns when the event's dates have passed, and not before or on the last day", () => {
    const input = { endsOn: "2026-10-11", timezone: "America/Chicago" };
    expect(getEventPublishWarnings(input, new Date("2026-09-29T12:00:00.000Z"))).toEqual([]);
    expect(getEventPublishWarnings(input, lastDayEnd)).toEqual([]);
    expect(getEventPublishWarnings(input, nextDayStart)).toEqual([
      "This event's dates have passed; public registration will be closed.",
    ]);
    expect(pastEventPublishWarning).toBe(
      "This event's dates have passed; public registration will be closed.",
    );
  });

  it("publishes a past event and returns the warning instead of blocking", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T12:00:00.000Z"));
    try {
      dependencies.getCurrentSession.mockResolvedValue({});
      dependencies.requirePermission.mockResolvedValue({ user: { id: "user_1" } });
      dependencies.publishEvent.mockResolvedValue({
        id: "event_1",
        isPublished: true,
        endsOn: "2026-10-11",
        timezone: "America/Chicago",
      });
      const response = await PUBLISH(
        new Request("https://events.imsda.test/api/events/event_1/publish", {
          method: "POST",
          headers: { origin: "https://events.imsda.test" },
        }),
        { params: Promise.resolve({ eventId: "event_1" }) },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        event: { isPublished: true },
        warnings: [pastEventPublishWarning],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
