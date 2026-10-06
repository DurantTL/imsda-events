import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A club director sees only their own club's packet (#411), the same
 * roster-access gate as `loadDirectorClubAssignment` (#410): the club whose
 * packet is fetched always comes from the verified roster session, never
 * from the caller-supplied organization id.
 */
const mocks = vi.hoisted(() => ({
  getRosterAccessState: vi.fn(),
  getClubPacketData: vi.fn(),
  findSubmission: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessState: mocks.getRosterAccessState }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ clubEventRegistration: { findUnique: mocks.findSubmission } }),
}));
vi.mock("@/modules/reporting/club-packet-repository", () => ({ getClubPacketData: mocks.getClubPacketData }));

import { loadDirectorClubPacket } from "@/modules/reporting/director-club-packet";

const clubA = { organizationId: "org-a", name: "Pathfinder Pioneers", role: "DIRECTOR" };
const packetA = { club: { organizationId: "org-a" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClubPacketData.mockResolvedValue(packetA);
  mocks.findSubmission.mockResolvedValue(null);
});

describe("loadDirectorClubPacket", () => {
  it("a director of club A requesting club B's URL still only ever reads club A's packet", async () => {
    // Roster access resolves to the director's own club, regardless of the
    // organizationId in the URL — mirroring what getRosterAccessState does
    // for a genuine cross-club URL edit attempt.
    mocks.getRosterAccessState.mockResolvedValue({
      state: "OPEN", club: clubA, capabilities: { roster: true }, accountId: "account-1", sessionId: "session-1",
    });
    await loadDirectorClubPacket("org-b", "event-1");
    expect(mocks.getRosterAccessState).toHaveBeenCalledWith("org-b");
    expect(mocks.getClubPacketData).toHaveBeenCalledWith("event-1", "org-a", "");
    expect(mocks.getClubPacketData).not.toHaveBeenCalledWith("event-1", "org-b");
  });

  it.each([
    { state: "NOT_FOUND" },
    { state: "SIGN_IN" },
    { state: "OWN_SESSION_REQUIRED", club: clubA },
    { state: "MFA_SETUP", club: clubA },
    { state: "MFA_UNLOCK", club: clubA, methods: { code: true, passkey: false } },
    { state: "NO_ROSTER", club: clubA, capabilities: { roster: false } },
  ])("returns null without reading the packet for $state", async (access) => {
    mocks.getRosterAccessState.mockResolvedValue(access);
    await expect(loadDirectorClubPacket("org-a", "event-1")).resolves.toBeNull();
    expect(mocks.getClubPacketData).not.toHaveBeenCalled();
  });

  it("reads this exact club and event when the roster is OPEN", async () => {
    mocks.getRosterAccessState.mockResolvedValue({
      state: "OPEN", club: clubA, capabilities: { roster: true }, accountId: "account-1", sessionId: "session-1",
    });
    await expect(loadDirectorClubPacket("org-a", "event-1")).resolves.toMatchObject(packetA);
    expect(mocks.getClubPacketData).toHaveBeenCalledWith("event-1", "org-a", "");
  });

  it("never carries what the church owes to the director, only the per-person price (#621)", async () => {
    mocks.getRosterAccessState.mockResolvedValue({
      state: "OPEN", club: clubA, capabilities: { roster: true }, accountId: "account-1", sessionId: "session-1",
    });
    mocks.getClubPacketData.mockResolvedValue({ ...packetA, amountOwedCents: 4500, isBilled: true });
    mocks.findSubmission.mockResolvedValue({
      registration: {
        publicFormSubmission: {
          pricingSnapshot: { lineItems: [{ label: "Fee", amountCents: 2500, attendeeIndex: 0, attendeeLabel: "A" }] },
        },
      },
    });
    const packet = await loadDirectorClubPacket("org-a", "event-1");
    expect(packet?.amountOwedCents).toBeNull();
    expect(packet?.perPersonPrice?.notice).toBe("$25 per person. Your church is billed after the event.");
    expect(JSON.stringify(packet)).not.toContain("4500");
  });

  it("prices the director's packet from the latest amendment, not the original submission (#621)", async () => {
    mocks.getRosterAccessState.mockResolvedValue({
      state: "OPEN", club: clubA, capabilities: { roster: true }, accountId: "account-1", sessionId: "session-1",
    });
    mocks.findSubmission.mockResolvedValue({
      registration: {
        publicFormSubmission: {
          pricingSnapshot: { lineItems: [{ label: "Fee", amountCents: 2500, attendeeIndex: 0, attendeeLabel: "A" }], attendeeCount: 1 },
        },
        operations: [{
          afterSnapshot: {
            pricingSnapshot: { lineItems: [{ label: "Fee", amountCents: 3000, attendeeIndex: 0, attendeeLabel: "A" }], attendeeCount: 1 },
          },
        }],
      },
    });
    const packet = await loadDirectorClubPacket("org-a", "event-1");
    expect(packet?.perPersonPrice?.notice).toBe("$30 per person. Your church is billed after the event.");
  });
});
