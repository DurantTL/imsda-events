import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => {
  class MockPublicRegistrationError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly issues: unknown[] = [],
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
}));

vi.mock("@/modules/rate-limit/service", () => rateLimitMocks);

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

function postRequest() {
  return new Request(
    "https://events.imsda.test/api/public/events/summer-retreat/forms/attendee/registrations",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://events.imsda.test",
      },
      body: JSON.stringify(submission),
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
});
