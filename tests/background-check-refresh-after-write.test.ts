import { beforeEach, describe, expect, it, vi } from "vitest";

// The best-effort cache fill after a save (#527 B5): a refresh failure is
// logged and never fails the user's save.

const mocks = vi.hoisted(() => ({
  refreshBackgroundCheckMatches: vi.fn(),
  registrationFindMany: vi.fn(),
  logError: vi.fn(),
  after: vi.fn<(work: () => Promise<void>) => void>(() => { throw new Error("`after` was called outside a request scope."); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ registration: { findMany: mocks.registrationFindMany } }) }));
vi.mock("@/lib/logger", () => ({ logError: mocks.logError }));
vi.mock("@/modules/background-checks/repository", () => ({ refreshBackgroundCheckMatches: mocks.refreshBackgroundCheckMatches }));
vi.mock("next/server", () => ({ after: mocks.after }));

import {
  refreshBackgroundCheckMatchesForRegistrations,
  refreshBackgroundCheckMatchesSafely,
} from "@/modules/background-checks/refresh-after-write";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refreshBackgroundCheckMatches.mockResolvedValue(undefined);
  mocks.after.mockImplementation(() => { throw new Error("`after` was called outside a request scope."); });
});

describe("refreshing background-check matches after a save (#527)", () => {
  it("refreshes each person once, and skips an empty list", async () => {
    await refreshBackgroundCheckMatchesSafely(["p-1", "p-1", null, undefined, "", "p-2"]);
    expect(mocks.refreshBackgroundCheckMatches).toHaveBeenCalledWith(["p-1", "p-2"]);
    await refreshBackgroundCheckMatchesSafely([]);
    expect(mocks.refreshBackgroundCheckMatches).toHaveBeenCalledTimes(1);
  });

  it("never throws when the refresh fails, and logs it without names", async () => {
    mocks.refreshBackgroundCheckMatches.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(refreshBackgroundCheckMatchesSafely(["p-1"])).resolves.toBeUndefined();
    expect(mocks.logError).toHaveBeenCalledWith("Background check match refresh failed after a save", expect.any(Error), { people: 1 });
  });

  it("refreshes a registration's account holder and every attendee", async () => {
    mocks.registrationFindMany.mockResolvedValue([
      { accountHolderPersonId: "p-holder", attendees: [{ personId: "p-holder" }, { personId: "p-spouse" }] },
    ]);
    await refreshBackgroundCheckMatchesForRegistrations(["reg-1", "reg-1"]);
    expect(mocks.registrationFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["reg-1"] } } }));
    expect(mocks.refreshBackgroundCheckMatches).toHaveBeenCalledWith(["p-holder", "p-spouse"]);
  });

  it("never throws when loading the registration fails", async () => {
    mocks.registrationFindMany.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(refreshBackgroundCheckMatchesForRegistrations(["reg-1"])).resolves.toBeUndefined();
    expect(mocks.refreshBackgroundCheckMatches).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalled();
  });

  it("inside a request, schedules the refresh after the response instead of making the save wait", async () => {
    let scheduled: (() => Promise<void>) | null = null;
    mocks.after.mockImplementation((work: () => Promise<void>) => { scheduled = work; });
    let finish!: () => void;
    mocks.refreshBackgroundCheckMatches.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    // Resolves at once even though the refresh itself would never finish.
    await expect(refreshBackgroundCheckMatchesSafely(["p-1"])).resolves.toBeUndefined();
    expect(mocks.refreshBackgroundCheckMatches).not.toHaveBeenCalled();
    expect(scheduled).not.toBeNull();
    const running = scheduled!();
    await vi.waitFor(() => expect(mocks.refreshBackgroundCheckMatches).toHaveBeenCalledWith(["p-1"]));
    finish();
    await running;
  });
});
