import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventFindMany: vi.fn(),
  entryFindMany: vi.fn(),
  entryFindUnique: vi.fn(),
  entryUpdate: vi.fn(),
  entryDelete: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => {
  const client = {
    event: { findMany: mocks.eventFindMany },
    calendarEntry: { findMany: mocks.entryFindMany, findUnique: mocks.entryFindUnique, update: mocks.entryUpdate, delete: mocks.entryDelete },
    $transaction: async (run: (tx: unknown) => unknown) => run(client),
  };
  return { getPrisma: () => client };
});
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));

import { deleteCalendarEntry, listPublicCalendarItems, updateCalendarEntry } from "@/modules/calendar/repository";

const imported = {
  id: "entry-1",
  title: "Synthetic Camporee",
  description: "",
  startsOn: "2026-10-09",
  endsOn: "2026-10-11",
  timeLabel: "",
  location: "Camp",
  category: "",
  linkUrl: null,
  status: "SCHEDULED",
  entryType: "STANDARD",
  repeatRule: null,
  repeatExceptions: [],
  isPublished: true,
  sourceFeedId: "feed-1",
  locallyEditedFields: [] as string[],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eventFindMany.mockResolvedValue([]);
  mocks.entryFindMany.mockResolvedValue([]);
  mocks.entryFindUnique.mockResolvedValue(imported);
  mocks.entryUpdate.mockImplementation(async ({ data }: { data: object }) => ({ ...imported, ...data }));
  mocks.entryFindMany.mockResolvedValue([]);
});

describe("public calendar and the feed", () => {
  it("never asks for imported items staff hid or that left their feed (page and feed.ics alike)", async () => {
    await listPublicCalendarItems("2026-10-01", "2026-12-31", new Date("2026-10-03T12:00:00Z"));
    await listPublicCalendarItems("2026-10-01", "2026-12-31", new Date("2026-10-03T12:00:00Z"), { expandRepeats: false });
    for (const call of mocks.entryFindMany.mock.calls) {
      expect(call[0].where).toMatchObject({ isPublished: true, isHiddenLocally: false, sourceRemovedAt: null });
    }
  });
});

describe("editing an imported item", () => {
  it("records the imported fields staff changed, and only those", async () => {
    await updateCalendarEntry("entry-1", {
      title: "Our title",
      description: "",
      location: "Camp",
      startsOn: "2026-10-09",
      endsOn: "2026-10-11",
      category: "Youth", // not a field the feed owns
      isPublished: false, // nor this
    }, "admin-1");
    expect(mocks.entryUpdate.mock.calls[0][0].data).toMatchObject({ title: "Our title", locallyEditedFields: ["title"] });
  });

  it("accumulates edits and treats an unchanged save as no edit", async () => {
    mocks.entryFindUnique.mockResolvedValue({ ...imported, locallyEditedFields: ["title"] });
    await updateCalendarEntry("entry-1", { location: "Elsewhere", endsOn: "2026-10-11", startsOn: "2026-10-09" }, "admin-1");
    expect(mocks.entryUpdate.mock.calls[0][0].data.locallyEditedFields.sort()).toEqual(["location", "title"]);

    mocks.entryUpdate.mockClear();
    await updateCalendarEntry("entry-1", { title: "Synthetic Camporee", location: "Camp" }, "admin-1");
    expect(mocks.entryUpdate.mock.calls[0][0].data).not.toHaveProperty("locallyEditedFields");
  });

  it("records a changed repeat as the repeat rule", async () => {
    await updateCalendarEntry("entry-1", { repeat: { frequency: "WEEKLY", interval: 1, weekdays: [], until: null, count: 4, weekStart: 0 } }, "admin-1");
    // 2026-10-09 is a Friday; a weekly rule with no weekdays follows it.
    expect(mocks.entryUpdate.mock.calls[0][0].data.locallyEditedFields).toEqual(["repeatRule"]);
  });

  it("leaves a staff-made entry exactly as before", async () => {
    mocks.entryFindUnique.mockResolvedValue({ ...imported, sourceFeedId: null, locallyEditedFields: [] });
    await updateCalendarEntry("entry-1", { title: "Changed" }, "admin-1");
    expect(mocks.entryUpdate.mock.calls[0][0].data).not.toHaveProperty("locallyEditedFields");
  });

  it("refuses to delete an imported item (a refresh would bring it back) but deletes a local one", async () => {
    await expect(deleteCalendarEntry("entry-1", "admin-1")).rejects.toMatchObject({ code: "INVALID_FEED" });
    expect(mocks.entryDelete).not.toHaveBeenCalled();
    mocks.entryFindUnique.mockResolvedValue({ ...imported, sourceFeedId: null });
    await deleteCalendarEntry("entry-1", "admin-1");
    expect(mocks.entryDelete).toHaveBeenCalledTimes(1);
  });
});
