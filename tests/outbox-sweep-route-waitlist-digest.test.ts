import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthorizedSweepRequest: vi.fn(),
  sweepOutbox: vi.fn(),
  recordSweepHeartbeat: vi.fn(),
  runAlertScan: vi.fn(),
  pruneExpiredCommunityContent: vi.fn(),
  sendDueLocationWaitlistDigests: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", async () => {
  const actual = await vi.importActual<typeof import("@/lib/logger")>("@/lib/logger");
  return { ...actual, logError: mocks.logError };
});
vi.mock("@/modules/communications/outbox-sweep", () => ({
  isAuthorizedSweepRequest: mocks.isAuthorizedSweepRequest,
  sweepOutbox: mocks.sweepOutbox,
}));
vi.mock("@/modules/community/repository", () => ({ pruneExpiredCommunityContent: mocks.pruneExpiredCommunityContent }));
vi.mock("@/modules/operations/alert-scan", () => ({ runAlertScan: mocks.runAlertScan }));
vi.mock("@/modules/operations/sweep-heartbeat-repository", () => ({ recordSweepHeartbeat: mocks.recordSweepHeartbeat }));
vi.mock("@/modules/event-locations/waitlist-digest", () => ({ sendDueLocationWaitlistDigests: mocks.sendDueLocationWaitlistDigests }));

import { POST } from "@/app/api/internal/outbox/sweep/route";

/**
 * The scheduled outbox sweep also sends the daily location waitlist digest
 * (#599), reusing the one cron and credential this repository already runs.
 */
const request = () => new Request("https://events.imsda.test/api/internal/outbox/sweep", { method: "POST", headers: { authorization: "Bearer synthetic" } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAuthorizedSweepRequest.mockReturnValue(true);
  mocks.sweepOutbox.mockResolvedValue({ sweptEventIds: [], skipped: [], sweptAccountMessages: false, snapshotBefore: { pending: 0 } });
  mocks.recordSweepHeartbeat.mockResolvedValue(undefined);
  mocks.runAlertScan.mockResolvedValue({ sent: [], suppressed: [], undelivered: [], cleared: [] });
  mocks.pruneExpiredCommunityContent.mockResolvedValue({ removed: 0 });
  mocks.sendDueLocationWaitlistDigests.mockResolvedValue({ status: "QUEUED", dateKey: "2026-10-06", changesCovered: 4, recipients: 2, messageIds: ["m1", "m2"], delivered: 2 });
});

describe("the sweep and the daily waitlist digest", () => {
  it("runs the digest on each sweep and reports what it did, without the message ids", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.sendDueLocationWaitlistDigests).toHaveBeenCalledTimes(1);
    const body = await response.json();
    expect(body.locationWaitlistDigest).toEqual({ status: "QUEUED", changesCovered: 4, recipients: 2, delivered: 2 });
  });

  it("runs nothing, digest included, for an unauthorized caller", async () => {
    mocks.isAuthorizedSweepRequest.mockReturnValue(false);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.sweepOutbox).not.toHaveBeenCalled();
    expect(mocks.sendDueLocationWaitlistDigests).not.toHaveBeenCalled();
  });

  it("stays a successful sweep when the digest fails: the failure is logged, never returned", async () => {
    mocks.sendDueLocationWaitlistDigests.mockRejectedValue(new Error("synthetic digest fault"));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).locationWaitlistDigest).toBeNull();
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining("location waitlist digest failed"), expect.any(Error));
    expect(mocks.recordSweepHeartbeat).toHaveBeenCalledWith("SUCCEEDED");
  });

  it("does not send the digest when the sweep itself fails", async () => {
    mocks.sweepOutbox.mockRejectedValue(new Error("synthetic sweep fault"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(mocks.sendDueLocationWaitlistDigests).not.toHaveBeenCalled();
  });
});
