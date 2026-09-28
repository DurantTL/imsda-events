import { describe, expect, it } from "vitest";
import { selectEventContext, type EventSelectionCandidate } from "@/modules/events/context-selection";

/**
 * `selectEventContext` (#465 — Q1: a wrong or missing event never silently
 * opens a different event). Pure decision logic; `resolveEventContext` in
 * `modules/events/selection.ts` is a thin, mocked-in-other-tests wrapper
 * around it.
 */

function draft(id: string, startsAt: string): EventSelectionCandidate {
  return {
    id,
    startsAt: new Date(startsAt),
    isPublished: false,
    timezone: "America/Chicago",
    registrationOpensOn: null,
    registrationClosesOn: null,
    waitlistEnabled: false,
  };
}

function published(
  id: string,
  startsAt: string,
  overrides: Partial<EventSelectionCandidate> = {},
): EventSelectionCandidate {
  return {
    id,
    startsAt: new Date(startsAt),
    isPublished: true,
    timezone: "America/Chicago",
    registrationOpensOn: null,
    registrationClosesOn: null,
    waitlistEnabled: false,
    ...overrides,
  };
}

const NOW = new Date("2027-01-15T12:00:00.000Z");

describe("selectEventContext — a requested id never resolves to another event", () => {
  const events = [published("evt_open", "2027-04-09T00:00:00.000Z"), draft("evt_draft", "2027-06-01T00:00:00.000Z")];

  it("uses the requested event when it matches one of the account's own events", () => {
    expect(selectEventContext({ events, requestedEventId: "evt_open", now: NOW })).toEqual({
      kind: "requested",
      event: events[0],
    });
  });

  it("never substitutes another event for a mistyped id", () => {
    expect(selectEventContext({ events, requestedEventId: "evt_0pen", now: NOW })).toEqual({ kind: "unavailable" });
  });

  it("never substitutes another event for a deleted or otherwise nonexistent id", () => {
    expect(selectEventContext({ events, requestedEventId: "evt_does_not_exist", now: NOW })).toEqual({ kind: "unavailable" });
  });

  it("never substitutes another event when the account isn't permitted on the requested one (staff — the event is simply absent from its own event list)", () => {
    // `events` is already filtered to this account's active memberships, so
    // "not permitted" and "doesn't exist" look identical here on purpose.
    expect(selectEventContext({ events, requestedEventId: "evt_other_clubs_event", now: NOW })).toEqual({ kind: "unavailable" });
  });

  it("never substitutes another event for a system administrator either — only a truly nonexistent id is unavailable, since a system admin's own event list already holds every event", () => {
    const allEvents = [published("evt_a", "2027-04-09T00:00:00.000Z"), published("evt_b", "2027-05-01T00:00:00.000Z")];
    expect(selectEventContext({ events: allEvents, requestedEventId: "evt_nonexistent", now: NOW })).toEqual({ kind: "unavailable" });
    expect(selectEventContext({ events: allEvents, requestedEventId: "evt_b", now: NOW })).toEqual({ kind: "requested", event: allEvents[1] });
  });

  it("stays unavailable even for a single-event account", () => {
    expect(selectEventContext({ events: [events[0]], requestedEventId: "evt_wrong", now: NOW })).toEqual({ kind: "unavailable" });
  });
});

describe("selectEventContext — no id given, the automatic order", () => {
  it("uses the account's only event with nothing to pick, even if it's a draft", () => {
    const onlyEvent = draft("evt_only", "2027-04-09T00:00:00.000Z");
    expect(selectEventContext({ events: [onlyEvent], now: NOW })).toEqual({ kind: "only", event: onlyEvent });
  });

  it("prefers the last-used-event cookie over the nearest event, when it's still one of the account's events", () => {
    const remembered = published("evt_remembered", "2027-08-01T00:00:00.000Z");
    const nearer = published("evt_nearer", "2027-01-20T00:00:00.000Z");
    const events = [nearer, remembered];

    expect(selectEventContext({ events, lastUsedEventId: "evt_remembered", now: NOW })).toEqual({
      kind: "cookie",
      event: remembered,
    });
  });

  it("ignores a remembered event the account can no longer open, falling through to the nearest published/open event instead", () => {
    const nearer = published("evt_nearer", "2027-01-20T00:00:00.000Z");
    const farther = published("evt_farther", "2027-08-01T00:00:00.000Z");
    const events = [nearer, farther];

    expect(selectEventContext({ events, lastUsedEventId: "evt_no_longer_a_member", now: NOW })).toEqual({
      kind: "nearest",
      event: nearer,
    });
  });

  it("picks the nearest OPEN event over a farther one, and over an unpublished draft that happens to be nearer", () => {
    const draftNearer = draft("evt_draft_nearer", "2027-01-16T00:00:00.000Z");
    const openFarther = published("evt_open_farther", "2027-03-01T00:00:00.000Z");
    const events = [draftNearer, openFarther];

    expect(selectEventContext({ events, now: NOW })).toEqual({ kind: "nearest", event: openFarther });
  });

  it("falls back to the nearest published event when none is currently OPEN (e.g. registration hasn't opened yet)", () => {
    const upcoming = published("evt_upcoming", "2027-02-01T00:00:00.000Z", { registrationOpensOn: "2027-01-25" });
    const fartherUpcoming = published("evt_farther_upcoming", "2027-06-01T00:00:00.000Z", { registrationOpensOn: "2027-05-01" });
    const events = [fartherUpcoming, upcoming];

    expect(selectEventContext({ events, now: NOW })).toEqual({ kind: "nearest", event: upcoming });
  });

  it("shows the picker when every event is an unpublished draft", () => {
    const events = [draft("evt_draft_1", "2027-01-16T00:00:00.000Z"), draft("evt_draft_2", "2027-06-01T00:00:00.000Z")];
    expect(selectEventContext({ events, now: NOW })).toEqual({ kind: "picker" });
  });

  it("shows the picker for a system administrator too, when nothing can be chosen automatically", () => {
    const events = [draft("evt_draft_1", "2027-01-16T00:00:00.000Z"), draft("evt_draft_2", "2027-06-01T00:00:00.000Z")];
    expect(selectEventContext({ events, lastUsedEventId: "evt_stale", now: NOW })).toEqual({ kind: "picker" });
  });

  it("picks automatically for a system administrator the same way as staff, given the same event list", () => {
    const nearer = published("evt_nearer", "2027-01-20T00:00:00.000Z");
    const farther = published("evt_farther", "2027-08-01T00:00:00.000Z");
    expect(selectEventContext({ events: [nearer, farther], now: NOW })).toEqual({ kind: "nearest", event: nearer });
  });
});
