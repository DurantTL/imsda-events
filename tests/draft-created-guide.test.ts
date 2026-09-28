import { describe, expect, it } from "vitest";
import {
  isDraftCreatedGuideDismissed,
  readDismissedDraftCreatedGuideEventIds,
  shouldShowDraftCreatedGuide,
  urlWithoutCreatedParam,
  withDraftCreatedGuideDismissed,
  writeDismissedDraftCreatedGuideEventIds,
} from "@/components/draft-created-guide";

describe("draft created guide: visibility", () => {
  it("shows only when created=1 is present, an event id is known, and it was not dismissed", () => {
    expect(shouldShowDraftCreatedGuide("1", "event_1", [])).toBe(true);
    expect(shouldShowDraftCreatedGuide(null, "event_1", [])).toBe(false);
    expect(shouldShowDraftCreatedGuide(undefined, "event_1", [])).toBe(false);
    expect(shouldShowDraftCreatedGuide("0", "event_1", [])).toBe(false);
    expect(shouldShowDraftCreatedGuide("1", "", [])).toBe(false);
    expect(shouldShowDraftCreatedGuide("1", null, [])).toBe(false);
  });

  it("never shows again for an event once its id has been recorded as dismissed", () => {
    expect(shouldShowDraftCreatedGuide("1", "event_1", ["event_1"])).toBe(false);
    expect(shouldShowDraftCreatedGuide("1", "event_1", ["event_2"])).toBe(true);
  });
});

describe("draft created guide: dismissal bookkeeping", () => {
  it("adds an event id once and is idempotent", () => {
    const once = withDraftCreatedGuideDismissed([], "event_1");
    expect(once).toEqual(["event_1"]);
    expect(isDraftCreatedGuideDismissed(once, "event_1")).toBe(true);

    const again = withDraftCreatedGuideDismissed(once, "event_1");
    expect(again).toEqual(["event_1"]);
  });

  it("never mutates the array passed in", () => {
    const original = ["event_1"];
    const next = withDraftCreatedGuideDismissed(original, "event_2");
    expect(original).toEqual(["event_1"]);
    expect(next).toEqual(["event_1", "event_2"]);
  });

  it("bounds the remembered list instead of growing without limit", () => {
    const many = Array.from({ length: 200 }, (_, index) => `event_${index}`);
    const next = withDraftCreatedGuideDismissed(many, "event_new");
    expect(next).toHaveLength(200);
    expect(next.at(-1)).toBe("event_new");
    expect(next).not.toContain("event_0");
  });
});

describe("draft created guide: URL cleanup on dismiss", () => {
  it("strips created while preserving the other query params", () => {
    expect(urlWithoutCreatedParam("/more/event-settings", "event=event_1&created=1"))
      .toBe("/more/event-settings?event=event_1");
  });

  it("drops the query string entirely when nothing else remains", () => {
    expect(urlWithoutCreatedParam("/more/event-settings", "created=1"))
      .toBe("/more/event-settings");
  });
});

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    raw: store,
  };
}

describe("draft created guide: storage", () => {
  it("reads back what it wrote", () => {
    const storage = fakeStorage();
    writeDismissedDraftCreatedGuideEventIds(storage, ["event_1", "event_2"]);
    expect(readDismissedDraftCreatedGuideEventIds(storage)).toEqual(["event_1", "event_2"]);
  });

  it("treats missing storage as no dismissals, never throwing", () => {
    expect(readDismissedDraftCreatedGuideEventIds(undefined)).toEqual([]);
    expect(() => writeDismissedDraftCreatedGuideEventIds(undefined, ["event_1"])).not.toThrow();
  });

  it("treats corrupt storage contents as no dismissals", () => {
    const storage = fakeStorage({ "imsda-events:draft-created-guide-dismissed": "not json" });
    expect(readDismissedDraftCreatedGuideEventIds(storage)).toEqual([]);
  });

  it("ignores a stored value that isn't an array of strings", () => {
    const storage = fakeStorage({
      "imsda-events:draft-created-guide-dismissed": JSON.stringify({ not: "an array" }),
    });
    expect(readDismissedDraftCreatedGuideEventIds(storage)).toEqual([]);
  });

  it("swallows a storage write failure rather than throwing", () => {
    const throwingStorage = {
      setItem: () => { throw new Error("quota exceeded"); },
    };
    expect(() => writeDismissedDraftCreatedGuideEventIds(throwingStorage, ["event_1"])).not.toThrow();
  });
});
