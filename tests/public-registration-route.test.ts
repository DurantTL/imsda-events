import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => {
  class MockPublicRegistrationError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly issues: unknown[] = [],
      public readonly meta: { roommateMiss?: boolean; eventId?: string } = {},
    ) {
      super(message);
      this.name = "PublicRegistrationError";
    }
  }

  return {
    PublicRegistrationError: MockPublicRegistrationError,
    getPublicRegistrationExperience: vi.fn(),
    submitPublicRegistration: vi.fn(),
  };
});

vi.mock("@/modules/forms/public-repository", () => repositoryMocks);

const rateLimitMocks = vi.hoisted(() => ({
  checkPublicRegistrationRateLimit: vi.fn(),
  checkPublicFormRoommateLookupRateLimit: vi.fn(),
  publicRequestClientHash: vi.fn(() => "client-hash-1"),
}));

vi.mock("@/modules/rate-limit/service", () => rateLimitMocks);

const auditMocks = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));

vi.mock("@/modules/audit/audit-service", () => auditMocks);

import { GET, POST } from "@/app/api/public/events/[eventSlug]/forms/[formSlug]/registrations/route";

const context = {
  params: Promise.resolve({ eventSlug: "summer-retreat", formSlug: "attendee" }),
};
const submission = {
  versionId: "version-1",
  idempotencyKey: "f4f76d46-f7d6-443d-a030-cb9a8ca15066",
  responses: {},
  website: "",
};

function postRequest(lodging?: unknown) {
  return new Request(
    "https://events.imsda.test/api/public/events/summer-retreat/forms/attendee/registrations",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://events.imsda.test",
      },
      body: JSON.stringify(lodging ? { ...submission, lodging } : submission),
    },
  );
}

function rateLimitOutcome(allowed: boolean) {
  return {
    allowed,
    decisions: [{
      policy: "public.registration.client-form",
      allowed,
      limit: 5,
      remaining: allowed ? 4 : 0,
      count: allowed ? 1 : 6,
      windowSeconds: 900,
      resetAfterSeconds: 321,
    }],
  };
}

beforeEach(() => {
  rateLimitMocks.checkPublicRegistrationRateLimit.mockResolvedValue(
    rateLimitOutcome(true),
  );
  rateLimitMocks.checkPublicFormRoommateLookupRateLimit.mockResolvedValue(
    rateLimitOutcome(true),
  );
  rateLimitMocks.publicRequestClientHash.mockReturnValue("client-hash-1");
  auditMocks.writeAuditLog.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("public registration route", () => {
  it("returns mutable public lifecycle data without caching it", async () => {
    repositoryMocks.getPublicRegistrationExperience.mockResolvedValue({
      lifecycle: {
        phase: "OPEN",
        capacityDecision: "WAITLIST",
        remainingSpots: 0,
        waitingRegistrations: 3,
      },
    });

    const response = await GET(new Request("https://events.imsda.test/api/public"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      experience: {
        lifecycle: {
          phase: "OPEN",
          capacityDecision: "WAITLIST",
          remainingSpots: 0,
        },
      },
    });
  });

  it("returns a typed 404 for an unavailable public form", async () => {
    repositoryMocks.getPublicRegistrationExperience.mockResolvedValue(null);

    const response = await GET(new Request("https://events.imsda.test/api/public"), context);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "FORM_NOT_FOUND" });
  });

  it.each([
    ["REGISTRATION_NOT_OPEN", 409],
    ["REGISTRATION_CLOSED", 410],
    ["EVENT_FULL", 409],
  ])("maps %s to a clear HTTP status", async (code, expectedStatus) => {
    repositoryMocks.submitPublicRegistration.mockRejectedValue(
      new repositoryMocks.PublicRegistrationError(code, `Lifecycle failure: ${code}`),
    );

    const response = await POST(postRequest(), context);
    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      error: code,
      message: `Lifecycle failure: ${code}`,
    });
  });

  it("returns the non-payable waitlist disposition created by the transaction", async () => {
    repositoryMocks.submitPublicRegistration.mockResolvedValue({
      confirmationCode: "REG-WAITLIST",
      registrationStatus: "WAITLISTED",
      capacityDecision: "WAITLIST",
      paymentEligible: false,
      paymentCollected: false,
      cardSelected: false,
      waitlistPosition: 4,
    });

    const response = await POST(postRequest(), context);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      confirmation: {
        registrationStatus: "WAITLISTED",
        capacityDecision: "WAITLIST",
        paymentEligible: false,
        paymentCollected: false,
        cardSelected: false,
        waitlistPosition: 4,
      },
    });
  });

  it("rejects an exhausted registration bucket before creating a registration", async () => {
    rateLimitMocks.checkPublicRegistrationRateLimit.mockResolvedValue(
      rateLimitOutcome(false),
    );

    const response = await POST(postRequest(), context);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("321");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
    expect(repositoryMocks.submitPublicRegistration).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ error: "RATE_LIMITED" });
  });

  const roommateLodging = {
    category: "DORM_ROOM",
    firstNight: "2027-06-15",
    lastNight: "2027-06-17",
    partySize: 2,
    roommates: [{ name: "Sam Example", confirmationCode: "ABCD-EFGH" }],
  };

  it("applies the tighter roommate lookup budget only to submissions that ask for a roommate by code", async () => {
    repositoryMocks.submitPublicRegistration.mockResolvedValue({ confirmationCode: "REG-1", registrationStatus: "CONFIRMED" });
    await POST(postRequest(), context);
    expect(rateLimitMocks.checkPublicFormRoommateLookupRateLimit).not.toHaveBeenCalled();

    rateLimitMocks.checkPublicFormRoommateLookupRateLimit.mockResolvedValue(rateLimitOutcome(false));
    const response = await POST(postRequest(roommateLodging), context);
    expect(rateLimitMocks.checkPublicFormRoommateLookupRateLimit).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(429);
    expect(repositoryMocks.submitPublicRegistration).toHaveBeenCalledTimes(1);
  });

  it("audits a roommate lookup miss outside the transaction by client hash and form only", async () => {
    repositoryMocks.submitPublicRegistration.mockRejectedValue(
      new repositoryMocks.PublicRegistrationError("LODGING_ROOMMATE_NOT_FOUND", "No match.", [], { roommateMiss: true, eventId: "event-1" }),
    );
    const response = await POST(postRequest(roommateLodging), context);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(auditMocks.writeAuditLog).toHaveBeenCalledTimes(1);
    const entry = auditMocks.writeAuditLog.mock.calls[0][0];
    expect(entry).toMatchObject({ eventId: "event-1", action: "LODGING_ROOMMATE_LOOKUP_MISSED", metadata: { clientHash: "client-hash-1", formSlug: "attendee" } });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("Sam Example");
    expect(serialized).not.toContain("ABCD-EFGH");
  });
});
