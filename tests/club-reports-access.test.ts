import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Permission boundary for the four Camporee club reports, their CSVs, and
 * the staff club-pass QR (#411): `VIEW_REPORTS` on this event, or a
 * Pathfinder event manager's oversight (#387) — an event administrator, but
 * only on a club (church-billed) event. Everyone else is denied.
 */
const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ event: { findUnique: mocks.findUnique } }) }));

import { AccessDeniedError } from "@/modules/access/authorization";
import { requireClubReportsAccess } from "@/modules/reporting/club-reports-access";

const session = { user: { id: "user-1", email: "u@example.org", displayName: "U" } };

function lookup(role: string | null) {
  return vi.fn().mockResolvedValue(role ? { eventId: "event-1", userId: "user-1", role, status: "ACTIVE", permissions: [] } : null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireClubReportsAccess", () => {
  it("allows a staff member holding VIEW_REPORTS (e.g. a registration manager), without checking the event's billing mode", async () => {
    await requireClubReportsAccess(session, "event-1", lookup("REGISTRATION_MANAGER"));
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("allows an event administrator (VIEW_REPORTS is part of that role's full grant) without checking the event's billing mode", async () => {
    await requireClubReportsAccess(session, "event-1", lookup("EVENT_ADMIN"));
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to the event's billing mode only for a member who lacks VIEW_REPORTS but is an event administrator by role", async () => {
    // Exercises the oversight fallback directly: even without VIEW_REPORTS in
    // hand, an EVENT_ADMIN membership on a club (church-billed) event passes.
    const membershipLookup = vi.fn().mockResolvedValue({
      eventId: "event-1", userId: "user-1", role: "EVENT_ADMIN", status: "ACTIVE", permissions: [],
    });
    mocks.findUnique.mockResolvedValue({ billingMode: "DEFERRED_ORGANIZATION_INVOICE" });
    await expect(requireClubReportsAccess(session, "event-1", membershipLookup)).resolves.toBeDefined();
  });

  it("denies a staff member with neither VIEW_REPORTS nor event-administrator oversight", async () => {
    await expect(requireClubReportsAccess(session, "event-1", lookup("READ_ONLY_STAFF"))).rejects.toBeInstanceOf(AccessDeniedError);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("denies someone with no membership on the event at all", async () => {
    await expect(requireClubReportsAccess(session, "event-1", lookup(null))).rejects.toBeInstanceOf(AccessDeniedError);
  });
});
