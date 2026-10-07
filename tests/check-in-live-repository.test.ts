import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { LIVE_CHANGES_LIMIT, parseLiveCheckInChanges } from "@/modules/checkin/live-changes";
import { listCheckInChanges } from "@/modules/checkin/live-repository";

function rows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    registrationAttendeeId: `attendee_${index}`,
    checkedInAt: new Date(Date.UTC(2026, 9, 9, 14, 0, 0) - index * 1000),
    undoneAt: null,
  }));
}

function prismaReturning(found: ReturnType<typeof rows>) {
  const findMany = vi.fn().mockResolvedValue(found);
  dependencies.getPrisma.mockReturnValue({ checkIn: { findMany } });
  return findMany;
}

beforeEach(() => vi.clearAllMocks());

describe("live check-in delta (#825)", () => {
  it("answers with the changes and no truncation flag when everything fits", async () => {
    const findMany = prismaReturning(rows(3));
    const answer = await listCheckInChanges("event_1", new Date("2026-10-09T13:00:00Z"));
    expect(answer.changes).toHaveLength(3);
    expect("truncated" in answer).toBe(false);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: LIVE_CHANGES_LIMIT + 1 }));
  });

  it("says so when the limit is hit, so the client reloads the roster instead of trusting a partial list", async () => {
    prismaReturning(rows(LIVE_CHANGES_LIMIT + 1));
    const answer = await listCheckInChanges("event_1", new Date("2026-10-09T13:00:00Z"));
    expect(answer.truncated).toBe(true);
    expect(answer.changes).toHaveLength(LIVE_CHANGES_LIMIT);
  });

  it("an answer of exactly the limit is complete", async () => {
    prismaReturning(rows(LIVE_CHANGES_LIMIT));
    const answer = await listCheckInChanges("event_1", new Date("2026-10-09T13:00:00Z"));
    expect(answer.truncated).toBeUndefined();
  });

  it("the client keeps the flag when it parses the answer", () => {
    expect(parseLiveCheckInChanges({ now: "2026-10-09T14:00:00.000Z", changes: [], truncated: true }))
      .toEqual({ now: "2026-10-09T14:00:00.000Z", changes: [], truncated: true });
    expect(parseLiveCheckInChanges({ now: "2026-10-09T14:00:00.000Z", changes: [], truncated: "yes" }))
      .toEqual({ now: "2026-10-09T14:00:00.000Z", changes: [] });
  });
});
