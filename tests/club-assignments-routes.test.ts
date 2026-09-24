import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Club assignment routes (#410) through the real permission checks: only the
 * session, the membership lookup, and the database are stubbed, so a 403 here
 * proves the route is wired to the right permission, not that a mock said no.
 */
const mocks = vi.hoisted(() => {
  class MockMessagingError extends Error {
    constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
      super(message);
    }
  }
  return {
    MessagingError: MockMessagingError,
    getCurrentSession: vi.fn(),
    findActiveMembership: vi.fn(),
    rejectCrossOriginRequest: vi.fn(),
    getPrisma: vi.fn(),
    writeAuditLog: vi.fn(),
    enqueueClubAssignmentBatch: vi.fn(),
    getClubAssignmentMessagePreview: vi.fn(),
    getMessagingWorkspace: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/modules/events/repository", () => ({ findActiveMembership: mocks.findActiveMembership }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/registrations/amendments-repository", () => ({ currentRegistrationAnswers: vi.fn() }));
vi.mock("@/modules/communications/messaging-repository", () => ({
  MessagingError: mocks.MessagingError,
  enqueueClubAssignmentBatch: mocks.enqueueClubAssignmentBatch,
  getClubAssignmentMessagePreview: mocks.getClubAssignmentMessagePreview,
  getMessagingWorkspace: mocks.getMessagingWorkspace,
}));

import { PUT } from "@/app/api/events/[eventId]/club-assignments/[organizationId]/route";
import { POST } from "@/app/api/events/[eventId]/club-assignment-messages/route";

const staff = { id: "staff-1", email: "staff@example.test", displayName: "Staff Member" };

function membership(role: string) {
  return { eventId: "event-1", userId: "staff-1", role, status: "ACTIVE", permissions: [] };
}

function putRequest(organizationId: string) {
  return new Request(`https://events.imsda.test/api/events/event-1/club-assignments/${organizationId}`, {
    method: "PUT",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify({ campsiteLocation: "Field C, site 12" }),
  });
}

function putContext(organizationId: string) {
  return { params: Promise.resolve({ eventId: "event-1", organizationId }) };
}

/** Club org-b is registered only on event-2; org-a is on event-1. */
function prismaWithRegistrations() {
  const registrations = [
    { eventId: "event-1", organizationId: "org-a", id: "cer-a", registration: { status: "CONFIRMED" } },
    { eventId: "event-2", organizationId: "org-b", id: "cer-b", registration: { status: "CONFIRMED" } },
  ];
  const tx = {
    clubEventRegistration: {
      findUnique: vi.fn(async ({ where }: { where: { eventId_organizationId: { eventId: string; organizationId: string } } }) => {
        const key = where.eventId_organizationId;
        const row = registrations.find((entry) => entry.eventId === key.eventId && entry.organizationId === key.organizationId);
        return row ? { id: row.id, registration: row.registration } : null;
      }),
    },
    clubEventAssignment: { findUnique: vi.fn(), upsert: vi.fn() },
  };
  return {
    tx,
    prisma: { ...tx, $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentSession.mockResolvedValue({ user: staff });
});

describe("PUT /api/events/[eventId]/club-assignments/[organizationId]", () => {
  it("returns 404 for a club that has no registration on any event", async () => {
    mocks.findActiveMembership.mockResolvedValue(membership("REGISTRATION_MANAGER"));
    const { prisma, tx } = prismaWithRegistrations();
    mocks.getPrisma.mockReturnValue(prisma);

    const response = await PUT(putRequest("org-unregistered"), putContext("org-unregistered"));
    expect(response.status).toBe(404);
    expect(tx.clubEventAssignment.upsert).not.toHaveBeenCalled();
  });

  it("returns 404 for a club registered only on another event", async () => {
    mocks.findActiveMembership.mockResolvedValue(membership("REGISTRATION_MANAGER"));
    const { prisma, tx } = prismaWithRegistrations();
    mocks.getPrisma.mockReturnValue(prisma);

    const response = await PUT(putRequest("org-b"), putContext("org-b"));
    expect(response.status).toBe(404);
    expect(tx.clubEventRegistration.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { eventId_organizationId: { eventId: "event-1", organizationId: "org-b" } },
    }));
    expect(tx.clubEventAssignment.upsert).not.toHaveBeenCalled();
  });

  it("returns 403 without MANAGE_REGISTRATION and never touches the database", async () => {
    mocks.findActiveMembership.mockResolvedValue(membership("COMMUNICATIONS_MANAGER"));
    const { prisma } = prismaWithRegistrations();
    mocks.getPrisma.mockReturnValue(prisma);

    const response = await PUT(putRequest("org-a"), putContext("org-a"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "PERMISSION_DENIED" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/events/[eventId]/club-assignment-messages", () => {
  it("returns 403 for a registration manager without MANAGE_COMMUNICATIONS and creates nothing", async () => {
    mocks.findActiveMembership.mockResolvedValue(membership("REGISTRATION_MANAGER"));
    const response = await POST(
      new Request("https://events.imsda.test/api/events/event-1/club-assignment-messages", {
        method: "POST",
        headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
        body: JSON.stringify({
          batchId: "0b9a3c1e-4f5d-4e6a-8b7c-9d0e1f2a3b4c",
          previewFingerprint: "a".repeat(64),
          scope: "ALL_SET",
        }),
      }),
      { params: Promise.resolve({ eventId: "event-1" }) },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "PERMISSION_DENIED" });
    expect(mocks.enqueueClubAssignmentBatch).not.toHaveBeenCalled();
  });
});
