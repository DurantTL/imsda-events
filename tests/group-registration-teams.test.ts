import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ eventFindFirst: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ event: { findFirst: mocks.eventFindFirst } }) }));

import { getGroupRegistrationExperience, submitGroupRegistration } from "@/modules/group-registrations/repository";

describe("group registration on an event with team rules (#809)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The query itself excludes an event with team settings, so the database answers "no such event".
    mocks.eventFindFirst.mockResolvedValue(null);
  });

  it("asks only for events without team settings, so the group page is refused", async () => {
    await expect(getGroupRegistrationExperience("pbe-event")).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(mocks.eventFindFirst.mock.calls[0]![0].where.teamSettings).toEqual({ is: null });
  });

  it("refuses a group submission the same way", async () => {
    await expect(submitGroupRegistration("pbe-event", {} as never)).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(mocks.eventFindFirst.mock.calls[0]![0].where.teamSettings).toEqual({ is: null });
  });
});
