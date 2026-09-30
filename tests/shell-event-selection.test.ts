import { describe, expect, it } from "vitest";
import { eventToRemember, resolveShellEvent } from "@/components/shell-event-selection";

const events = [{ id: "evt_wr" }, { id: "evt_x" }];

describe("resolveShellEvent (#616)", () => {
  it("keeps the last seen event after a soft navigation with no ?event=", () => {
    // Layout default is still Women's Retreat; the user had seen ?event=evt_x.
    const selected = resolveShellEvent({ requestedEventId: null, events, seenEventId: "evt_x", defaultEventId: "evt_wr" });
    expect(selected?.id).toBe("evt_x");
  });

  it("falls back to the layout default only when nothing has been seen", () => {
    expect(resolveShellEvent({ requestedEventId: null, events, seenEventId: null, defaultEventId: "evt_wr" })?.id).toBe("evt_wr");
    expect(resolveShellEvent({ requestedEventId: null, events, seenEventId: "evt_gone", defaultEventId: "evt_wr" })?.id).toBe("evt_wr");
  });

  it("lets ?event= win, and an unknown ?event= selects nothing", () => {
    expect(resolveShellEvent({ requestedEventId: "evt_wr", events, seenEventId: "evt_x", defaultEventId: "evt_wr" })?.id).toBe("evt_wr");
    expect(resolveShellEvent({ requestedEventId: "evt_nope", events, seenEventId: "evt_x", defaultEventId: "evt_wr" })).toBeUndefined();
  });
});

describe("eventToRemember (#616)", () => {
  const knownEventIds = ["evt_wr", "evt_x"];

  it("POSTs a valid event that differs from what was last remembered", () => {
    expect(eventToRemember({ requestedEventId: "evt_x", knownEventIds, lastRememberedId: "evt_wr" })).toBe("evt_x");
    expect(eventToRemember({ requestedEventId: "evt_wr", knownEventIds, lastRememberedId: "evt_x" })).toBe("evt_wr");
  });

  it("does not POST an unknown event, no event, or one already sent (no double POST)", () => {
    expect(eventToRemember({ requestedEventId: "evt_nope", knownEventIds, lastRememberedId: "evt_wr" })).toBeNull();
    expect(eventToRemember({ requestedEventId: null, knownEventIds, lastRememberedId: "evt_wr" })).toBeNull();
    expect(eventToRemember({ requestedEventId: "evt_x", knownEventIds, lastRememberedId: "evt_x" })).toBeNull();
  });
});
