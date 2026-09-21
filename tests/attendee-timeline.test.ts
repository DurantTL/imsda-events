import { describe, expect, it } from "vitest";
import {
  buildAttendeeTimelineItems,
  type AttendeeTimelineAnnouncement,
  type AttendeeTimelineCommunityPost,
} from "@/components/attendee-community-board";

const announcement: AttendeeTimelineAnnouncement = {
  id: "announcement-1",
  title: "Arrival update",
  body: "Check-in opens at 4 PM.",
  priority: "IMPORTANT",
  publishedAt: "2026-10-08T14:00:00.000Z",
};

const post: AttendeeTimelineCommunityPost = {
  id: "post-1",
  parentId: null,
  body: "Looking forward to the retreat!",
  status: "PUBLISHED",
  createdAt: "2026-10-08T15:00:00.000Z",
  authorName: "Attendee",
  isOwn: false,
  isReported: false,
  authorDeleted: false,
  editedAt: null,
  replies: [],
};

describe("attendee timeline", () => {
  it("combines official updates and community posts in reverse chronological order", () => {
    const timeline = buildAttendeeTimelineItems([announcement], [post], true);

    expect(timeline.map((item) => item.kind)).toEqual(["COMMUNITY", "OFFICIAL"]);
    expect(timeline.map((item) => item.occurredAt)).toEqual([
      "2026-10-08T15:00:00.000Z",
      "2026-10-08T14:00:00.000Z",
    ]);
  });

  it("keeps official updates available before an attendee accepts community conduct", () => {
    const timeline = buildAttendeeTimelineItems([announcement], [post], false);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: "OFFICIAL", announcement: { id: "announcement-1" } });
  });

  it("keeps a pinned official update above newer community activity", () => {
    const timeline = buildAttendeeTimelineItems([
      { ...announcement, pinnedAt: "2026-10-08T16:00:00.000Z" },
    ], [post], true);

    expect(timeline.map((item) => item.kind)).toEqual(["OFFICIAL", "COMMUNITY"]);
  });

  it("does not render an unpublished announcement without a published timestamp", () => {
    const timeline = buildAttendeeTimelineItems([
      { ...announcement, id: "draft-1", publishedAt: null },
    ], [], true);

    expect(timeline).toEqual([]);
  });
});
