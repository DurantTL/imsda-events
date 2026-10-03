import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { syncBodyForPreview } from "@/components/calendar-feeds-panel";

describe("applying a preview", () => {
  it("allows an empty feed only when the preview being applied was itself empty", () => {
    expect(syncBodyForPreview({ totalInFeed: 0 })).toEqual({ allowEmpty: true });
    expect(syncBodyForPreview({ totalInFeed: 1 })).toBeUndefined();
    expect(syncBodyForPreview({ totalInFeed: 250 })).toBeUndefined();
  });
});
