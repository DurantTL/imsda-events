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
  checkPublicPromoQuoteRateLimit: vi.fn(),
  writeAuditLog: vi.fn(),
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
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: dependencies.writeAuditLog }));
vi.mock("@/modules/rate-limit/service", () => ({
  checkPublicPromoQuoteRateLimit: dependencies.checkPublicPromoQuoteRateLimit,
}));
vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: dependencies.findActiveMembership,
  publishEvent: dependencies.publishEvent,
  EventOperationError: class EventOperationError extends Error {},
}));

import { POST as QUOTE_PROMO } from "@/app/api/public/events/[eventSlug]/forms/[formSlug]/promo-code/route";
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
import { clubRegistrationEditWindow } from "@/modules/club-registrations/domain";
import { ClassSelectionError, setClassSelections } from "@/modules/honors/enrollment-repository";
import { listPublicCalendarItems } from "@/modules/calendar/repository";

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

describe("last day in other time zones", () => {
  it("handles a last day that falls on the fall-back DST change (2026-11-01, Chicago)", () => {
    // Clocks go back at 2am CDT on Nov 1, so that local day is 25 hours long
    // and midnight after it is 06:00Z (CST), not 05:00Z.
    const dst = { ...event, endsAt: new Date("2026-11-01T20:00:00.000Z") };
    expect(evaluateEventRegistrationPhase(dst, new Date("2026-11-01T05:00:00.000Z"))).toBe("OPEN");
    expect(evaluateEventRegistrationPhase(dst, new Date("2026-11-02T05:59:59.999Z"))).toBe("OPEN");
    expect(evaluateEventRegistrationPhase(dst, new Date("2026-11-02T06:00:00.000Z"))).toBe("CLOSED");
  });

  it("uses Pacific/Honolulu (UTC-10, no DST) for the last day", () => {
    const honolulu = {
      ...event,
      timezone: "Pacific/Honolulu",
      endsAt: new Date("2026-10-12T03:00:00.000Z"), // Oct 11, 5pm HST
    };
    // 09:59:59Z on Oct 12 is still Oct 11 in Honolulu; 10:00Z is Oct 12.
    expect(evaluateEventRegistrationPhase(honolulu, new Date("2026-10-12T09:59:59.999Z"))).toBe("OPEN");
    expect(evaluateEventRegistrationPhase(honolulu, new Date("2026-10-12T10:00:00.000Z"))).toBe("CLOSED");
    // In Chicago that same instant would already have closed hours earlier.
    expect(evaluateEventRegistrationPhase(
      { ...honolulu, timezone: "America/Chicago" },
      new Date("2026-10-12T09:59:59.999Z"),
    )).toBe("CLOSED");
  });
});

describe("closed wording", () => {
  const closedWindow = {
    phase: "CLOSED" as const,
    registrationClosesOn: "2026-12-31",
    today: "2026-10-12",
    eventDate: "2026-10-09",
  };

  it("names the event as closed instead of quoting a later closing date once it has ended", () => {
    const ended = clubRegistrationEditWindow({ ...closedWindow, ended: true });
    expect(ended).toEqual({
      open: false,
      message: expect.stringContaining("Registration for this event has closed."),
    });
    expect((ended as { message: string }).message).not.toContain("December");
  });

  it("still quotes the closing date when only the window has closed", () => {
    const windowClosed = clubRegistrationEditWindow({ ...closedWindow, registrationClosesOn: "2026-10-01" });
    expect((windowClosed as { message: string }).message).toContain("October 1, 2026");
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

  it("refuses a promo quote after the last day", async () => {
    dependencies.getPrisma.mockReturnValue({
      registrationForm: { findFirst: vi.fn().mockResolvedValue(formRow()) },
    });
    const quoteInput = {
      versionId: "version_1",
      code: "SAVE10",
      responses: { full_name: "Closed Tester" },
    } as Parameters<typeof getPublicPromoCodeQuote>[2];

    const closed = getPublicPromoCodeQuote("synthetic-retreat", "registration", quoteInput, nextDayStart);
    await expect(closed).rejects.toBeInstanceOf(PublicPromoCodeError);
    await expect(closed).rejects.toMatchObject({
      reason: "REGISTRATION_CLOSED",
      message: "Registration for this event has closed.",
    });
  });

  it("does not refuse a promo quote on the last day", async () => {
    // One instant earlier the request gets past the closed check and fails
    // on the unknown promo code instead.
    dependencies.getPrisma.mockReturnValue({
      registrationForm: { findFirst: vi.fn().mockResolvedValue(formRow()) },
      promoCode: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    const quoteInput = {
      versionId: "version_1",
      code: "SAVE10",
      responses: { full_name: "Closed Tester" },
    } as Parameters<typeof getPublicPromoCodeQuote>[2];

    const open = getPublicPromoCodeQuote("synthetic-retreat", "registration", quoteInput, lastDayEnd);
    await expect(open).rejects.toBeInstanceOf(PublicPromoCodeError);
    await expect(open).rejects.not.toMatchObject({ reason: "REGISTRATION_CLOSED" });
  });

  it("maps a closed promo quote to HTTP 410 in the route", async () => {
    dependencies.checkPublicPromoQuoteRateLimit.mockResolvedValue({
      allowed: true, decisions: [],
    });
    dependencies.getPrisma.mockReturnValue({
      registrationForm: { findFirst: vi.fn().mockResolvedValue(formRow()) },
    });
    vi.useFakeTimers();
    vi.setSystemTime(nextDayStart);
    try {
      const response = await QUOTE_PROMO(
        new Request("https://events.imsda.test/api/public/promo", {
          method: "POST",
          headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
          body: JSON.stringify({
            versionId: "version_1",
            code: "SAVE10",
            responses: { full_name: "Closed Tester" },
          }),
        }),
        { params: Promise.resolve({ eventSlug: "synthetic-retreat", formSlug: "registration" }) },
      );
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ error: "REGISTRATION_CLOSED" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets staff still add a registration after the event has ended", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nextDayStart);
    try {
      const eventLookup = vi.fn();
      const created = {
        id: "registration_1",
        confirmationCode: "REG-STAFF",
        status: "CONFIRMED",
        totalAmount: 0,
        submittedAt: nextDayStart,
        createdAt: nextDayStart,
        updatedAt: nextDayStart,
        contactSnapshot: { firstName: "Staff", lastName: "Added", email: "", phone: "" },
        accountHolderPerson: { id: "person_1", firstName: "Staff", lastName: "Added", normalizedEmail: null, phone: null },
        attendees: [],
        payments: [],
        adjustments: [],
        messages: [],
        operations: [],
        publicFormSubmission: null,
        event: { billingMode: "ATTENDEE_PAY", attendeeTypes: [] },
      };
      const tx = {
        person: { create: vi.fn().mockResolvedValue({ id: "person_1" }) },
        registration: { create: vi.fn().mockResolvedValue({ id: "registration_1" }) },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
        event: { findUnique: eventLookup },
      };
      dependencies.getPrisma.mockReturnValue({
        $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
        registration: { findMany: vi.fn().mockResolvedValue([created]) },
      });
      dependencies.refreshBackgroundChecks.mockResolvedValue(undefined);

      await expect(createRegistration("event_1", {
        firstName: "Staff",
        lastName: "Added",
        email: "",
        phone: "",
        attendeeType: "ATTENDEE",
        status: "CONFIRMED",
        totalAmountCents: 0,
      }, "user_1")).resolves.toMatchObject({ id: "registration_1", confirmationCode: "REG-STAFF" });

      expect(tx.registration.create).toHaveBeenCalledTimes(1);
      expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
      expect(eventLookup).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("other paths that follow the phase", () => {
  it("closes honors class picks after the last day, saying the event has closed", async () => {
    const tx = {
      clubEventRegistration: {
        findUnique: vi.fn().mockResolvedValue({
          event: {
            id: "event_1",
            isPublished: true,
            endsAt: event.endsAt,
            timezone: "America/Chicago",
            registrationOpensOn: null,
            registrationClosesOn: "2026-12-31",
            waitlistEnabled: false,
          },
          registration: { id: "registration_1", status: "CONFIRMED", attendees: [] },
        }),
      },
      clubRosterMember: { findMany: vi.fn().mockResolvedValue([]) },
    };
    dependencies.getPrisma.mockReturnValue({
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    });

    const attempt = setClassSelections(
      "org_1", "event_1", { accountId: "account_1" }, {}, nextDayStart,
    );
    await expect(attempt).rejects.toBeInstanceOf(ClassSelectionError);
    await expect(attempt).rejects.toMatchObject({
      code: "DEADLINE_PASSED",
      message: "Registration for this event has closed.",
    });
  });

  it("clears the calendar's registrationOpen flag once the event has ended", async () => {
    const row = {
      id: "event_1",
      slug: "synthetic-retreat",
      name: "Synthetic Retreat",
      startsAt: new Date("2026-10-09T14:00:00.000Z"),
      endsAt: event.endsAt,
      timezone: "America/Chicago",
      location: "Camp",
      calendarCategory: null,
      isPublished: true,
      registrationOpensOn: null,
      registrationClosesOn: null,
      waitlistEnabled: false,
    };
    dependencies.getPrisma.mockReturnValue({
      event: { findMany: vi.fn().mockResolvedValue([row]) },
      calendarEntry: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const flag = async (now: Date) => (
      await listPublicCalendarItems("2026-10-01", "2026-11-30", now)
    ).find((item) => item.kind === "EVENT")?.registrationOpen;

    expect(await flag(lastDayEnd)).toBe(true);
    expect(await flag(nextDayStart)).toBe(false);
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
