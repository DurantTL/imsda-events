import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A club's packet is one registration's (#809): the team key picks it, and a team the club never registered, or another
 * club's, finds nothing. The reports' records are stubbed; the repository's own selection is real.
 */
const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), getClubEventRecords: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/reporting/club-event-reports-repository", () => ({ getClubEventRecords: mocks.getClubEventRecords }));

import { getClubPacketData } from "@/modules/reporting/club-packet-repository";
import { buildClubEventRecord } from "@/modules/reporting/club-event-reports";

const record = (organizationId: string, name: string, teamName: string | null, registrationId: string) => buildClubEventRecord({
  organizationId, organizationName: teamName ? `${teamName} (${name})` : name,
  ...(teamName ? { teamKey: teamName.toLowerCase(), teamName } : {}),
  sponsoringChurch: "Test SDA Church", registrationId, confirmationCode: `C-${registrationId}`, status: "CONFIRMED", submittedAt: null,
  registrationResponses: {}, attendees: [], amountOwedCents: 0, pricingSnapshot: {}, lateRateLabel: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPrisma.mockReturnValue({
    event: { findUnique: async () => ({ name: "Synthetic PBE", startsAt: new Date("2027-01-16T15:00:00Z"), endsAt: new Date("2027-01-16T22:00:00Z"), timezone: "America/Chicago" }) },
    eventLocation: { findUnique: async () => null },
  });
  mocks.getClubEventRecords.mockResolvedValue({
    clubs: [
      record("org-1", "Test Pathfinders", "Bible Bees", "r1"),
      record("org-1", "Test Pathfinders", "Sword Drill", "r2"),
      record("org-2", "Other Pathfinders", "Quiz Team", "r3"),
    ],
    assignments: new Map(),
    earlyBirdDeadline: null,
    registrations: [],
  });
});

describe("club packet for a team (#809)", () => {
  it("builds the packet of the team named, from that registration only", async () => {
    const packet = await getClubPacketData("event-1", "org-1", "sword drill");
    expect(packet?.club.confirmationCode).toBe("C-r2");
    expect(packet?.club.organizationName).toBe("Sword Drill (Test Pathfinders)");
  });

  it("finds nothing for a team the club never registered", async () => {
    expect(await getClubPacketData("event-1", "org-1", "not-a-team")).toBeNull();
  });

  it("finds nothing for another club's team under this club", async () => {
    expect(await getClubPacketData("event-1", "org-1", "quiz team")).toBeNull();
  });

  it("finds nothing for the club alone when it only has named teams", async () => {
    expect(await getClubPacketData("event-1", "org-1")).toBeNull();
  });
});
