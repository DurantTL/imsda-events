import { describe, expect, it } from "vitest";
import {
  attendeeCommunityActionSchema,
  staffCommunityActionSchema,
} from "@/modules/community/domain";

describe("community action validation", () => {
  it("bounds attendee posts and private reports", () => {
    expect(attendeeCommunityActionSchema.parse({
      action: "CREATE_POST",
      body: "Looking forward to the retreat!",
      parentId: null,
    })).toMatchObject({ action: "CREATE_POST" });
    expect(() => attendeeCommunityActionSchema.parse({
      action: "CREATE_POST",
      body: "x".repeat(1501),
    })).toThrow();
    expect(() => attendeeCommunityActionSchema.parse({
      action: "REPORT_POST",
      postId: "post-1",
      reason: "NOT_A_REASON",
    })).toThrow();
  });

  it("requires a substantial conduct agreement and bounded retention", () => {
    expect(staffCommunityActionSchema.parse({
      action: "UPDATE_SETTINGS",
      isEnabled: true,
      allowNewPosts: true,
      allowReplies: true,
      conductText: "Be kind, protect privacy, respect one another, and keep every post focused on the retreat.",
      retentionDays: 30,
    })).toMatchObject({ action: "UPDATE_SETTINGS", retentionDays: 30 });
    expect(() => staffCommunityActionSchema.parse({
      action: "UPDATE_SETTINGS",
      isEnabled: true,
      allowNewPosts: true,
      allowReplies: true,
      conductText: "Be nice.",
      retentionDays: 0,
    })).toThrow();
  });
});
