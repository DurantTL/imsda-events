import { describe, expect, it } from "vitest";
import { selectEventContext, type EventSelectionCandidate } from "@/modules/events/context-selection";
import { resolveClubsAndChurchesEntry, systemNavigation, withCurrentEvent } from "@/components/staff-navigation";

const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-09-29T12:00:00Z");
function event(id: string, offsetDays: number): EventSelectionCandidate {
  return {
    id,
    startsAt: new Date(now.getTime() + offsetDays * day),
    isPublished: true,
    timezone: "America/Chicago",
    registrationOpensOn: null,
    registrationClosesOn: null,
    waitlistEnabled: false,
  };
}

const events = [event("evt_default", 30), event("evt_chosen", 200)];

function eventParam(href: string) {
  return new URL(href, "https://x.test").searchParams.get("event");
}

describe("current event carries between staff areas (#616)", () => {
  it("adds, replaces and preserves query and hash", () => {
    expect(withCurrentEvent("/admin", "evt_chosen")).toBe("/admin?event=evt_chosen");
    expect(withCurrentEvent("/admin/organizations?q=a&event=old#x", "evt_chosen")).toBe("/admin/organizations?q=a&event=evt_chosen#x");
    expect(withCurrentEvent("/admin", null)).toBe("/admin");
  });

  it("dashboard to System management to Clubs and churches keeps a non-default event", () => {
    const chosen = "evt_chosen";
    expect(selectEventContext({ events, requestedEventId: chosen, now })).toMatchObject({ kind: "requested", event: { id: chosen } });

    const systemHref = withCurrentEvent(systemNavigation.href, chosen);
    expect(selectEventContext({ events, requestedEventId: eventParam(systemHref), now })).toMatchObject({ event: { id: chosen } });

    const clubs = resolveClubsAndChurchesEntry({ clubOversight: true, isSystemAdmin: true });
    const clubsHref = withCurrentEvent(clubs.href, chosen);
    expect(clubsHref).toBe("/admin/organizations?event=evt_chosen");
    expect(selectEventContext({ events, requestedEventId: eventParam(clubsHref), now })).toMatchObject({ event: { id: chosen } });
  });

  it("a page with no ?event= keeps the remembered selection, and falls back only when it is gone", () => {
    expect(selectEventContext({ events, lastUsedEventId: "evt_chosen", now })).toMatchObject({ kind: "cookie", event: { id: "evt_chosen" } });
    expect(selectEventContext({ events, lastUsedEventId: "evt_deleted", now })).toMatchObject({ kind: "nearest", event: { id: "evt_default" } });
  });
});
