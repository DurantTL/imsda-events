import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  resolveRegistrationAccessToken: vi.fn(),
  updatePublicRegistrationContactWithMessages: vi.fn(),
}));

vi.mock("@/modules/public-access/repository", () => repositoryMocks);

const messagingMocks = vi.hoisted(() => ({
  processQueuedMessageIdsAfterCommit: vi.fn(),
}));

vi.mock(
  "@/modules/communications/messaging-repository",
  () => messagingMocks,
);

const rateLimitMocks = vi.hoisted(() => ({
  checkPublicManageRateLimit: vi.fn(),
}));

vi.mock("@/modules/rate-limit/service", () => rateLimitMocks);

import {
  GET,
  PATCH,
} from "@/app/api/public/manage/[token]/route";

const token = "a".repeat(43);
const context = { params: Promise.resolve({ token }) };
const registrationView = {
  access: { expiresAt: "2026-11-10T18:00:00.000Z" },
  event: { name: "Women’s Retreat" },
  registration: {
    confirmationCode: "REG-PRIVATE",
    status: "SUBMITTED",
  },
  contact: {
    firstName: "Caleb",
    lastName: "Durant",
    email: "caleb@example.test",
    phone: "",
  },
  attendees: [{ name: "Caleb Durant" }],
  payment: {
    totalCents: 25_000,
    paidCents: 0,
    amountDueCents: 25_000,
  },
};

function patchRequest(
  body: unknown,
  origin = "https://events.imsda.test",
) {
  return new Request(
    `https://events.imsda.test/api/public/manage/${token}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify(body),
    },
  );
}

function rateLimitOutcome(allowed: boolean) {
  return {
    allowed,
    decisions: [{
      policy: "public.manage.update.client-token",
      allowed,
      limit: 10,
      remaining: allowed ? 9 : 0,
      count: allowed ? 1 : 11,
      windowSeconds: 900,
      resetAfterSeconds: 234,
    }],
  };
}

beforeEach(() => {
  rateLimitMocks.checkPublicManageRateLimit.mockResolvedValue(
    rateLimitOutcome(true),
  );
  messagingMocks.processQueuedMessageIdsAfterCommit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("private registration access route", () => {
  it("returns only the scoped registration view with private response headers", async () => {
    repositoryMocks.resolveRegistrationAccessToken.mockResolvedValue(
      registrationView,
    );

    const response = await GET(
      new Request(`https://events.imsda.test/api/public/manage/${token}`),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(await response.json()).toEqual({
      registration: registrationView,
    });
  });

  it("uses one generic unavailable response for invalid, expired, or revoked access", async () => {
    repositoryMocks.resolveRegistrationAccessToken.mockResolvedValue(null);

    const response = await GET(
      new Request(`https://events.imsda.test/api/public/manage/${token}`),
      context,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "REGISTRATION_ACCESS_UNAVAILABLE",
      message: "This private registration link is invalid or no longer active.",
    });
  });

  it("normalizes and saves only the four registration contact fields", async () => {
    repositoryMocks.updatePublicRegistrationContactWithMessages.mockResolvedValue({
      registration: {
        ...registrationView,
        contact: {
          firstName: "Caleb",
          lastName: "Durant",
          email: "caleb@example.test",
          phone: "555-0101",
        },
      },
      pendingMessageIds: ["message-contact-updated"],
    });

    const response = await PATCH(patchRequest({
      firstName: " Caleb ",
      lastName: " Durant ",
      email: " CALEB@EXAMPLE.TEST ",
      phone: " 555-0101 ",
    }), context);

    expect(response.status).toBe(200);
    expect(
      repositoryMocks.updatePublicRegistrationContactWithMessages,
    ).toHaveBeenCalledWith(token, {
      firstName: "Caleb",
      lastName: "Durant",
      email: "caleb@example.test",
      phone: "555-0101",
    });
    expect(
      messagingMocks.processQueuedMessageIdsAfterCommit,
    ).toHaveBeenCalledWith(
      ["message-contact-updated"],
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each([
    ["status", "CONFIRMED"],
    ["totalAmountCents", 0],
    ["responses", {}],
    ["attendees", []],
  ])("rejects an attempted public update to %s", async (field, value) => {
    const response = await PATCH(patchRequest({
      firstName: "Caleb",
      lastName: "Durant",
      email: "caleb@example.test",
      phone: "",
      [field]: value,
    }), context);

    expect(response.status).toBe(400);
    expect(
      repositoryMocks.updatePublicRegistrationContactWithMessages,
    ).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ error: "INVALID_CONTACT" });
  });

  it("rejects cross-origin writes before parsing or updating", async () => {
    const response = await PATCH(
      patchRequest(
        {
          firstName: "Caleb",
          lastName: "Durant",
          email: "caleb@example.test",
          phone: "",
        },
        "https://untrusted.example",
      ),
      context,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(
      repositoryMocks.updatePublicRegistrationContactWithMessages,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "read"],
    ["PATCH", "update"],
  ])("rate limits %s access by client and token before repository access", async (
    method,
    operation,
  ) => {
    rateLimitMocks.checkPublicManageRateLimit.mockResolvedValue(
      rateLimitOutcome(false),
    );

    const response = method === "GET"
      ? await GET(
        new Request(`https://events.imsda.test/api/public/manage/${token}`),
        context,
      )
      : await PATCH(patchRequest({
        firstName: "Caleb",
        lastName: "Durant",
        email: "caleb@example.test",
        phone: "",
      }), context);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("234");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(rateLimitMocks.checkPublicManageRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      token,
      operation,
    );
    expect(repositoryMocks.resolveRegistrationAccessToken).not.toHaveBeenCalled();
    expect(
      repositoryMocks.updatePublicRegistrationContactWithMessages,
    ).not.toHaveBeenCalled();
  });
});
