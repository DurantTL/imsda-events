import { describe, expect, it } from "vitest";
import {
  EVENT_PICKER_PATH,
  NO_EVENTS_PATH,
  SYSTEM_ADMIN_PATH,
  resolveLoginDestination,
} from "@/modules/access/login-routing";

describe("resolveLoginDestination", () => {
  it("sends a system administrator to the System Command Center", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: true,
      events: [],
    })).toBe(SYSTEM_ADMIN_PATH);
  });

  it("sends a system administrator to /admin even if they somehow carry events", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: true,
      events: [{ id: "event_1" }, { id: "event_2" }],
      lastEventId: "event_2",
    })).toBe(SYSTEM_ADMIN_PATH);
  });

  it("sends staff with exactly one active event straight to that event's workspace", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: false,
      events: [{ id: "event_1" }],
    })).toBe("/overview?event=event_1");
  });

  it("uses the same ?event= URL shape the event switcher uses", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: false,
      events: [{ id: "event with spaces" }],
    })).toBe(`/overview?event=${encodeURIComponent("event with spaces")}`);
  });

  it("sends staff with several events to their remembered event when it is still active", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: false,
      events: [{ id: "event_1" }, { id: "event_2" }, { id: "event_3" }],
      lastEventId: "event_2",
    })).toBe("/overview?event=event_2");
  });

  it("sends staff with several events to the picker when the remembered event is stale", () => {
    // "Stale" here means an event the account can no longer open — it left
    // the membership, or the event closed out of the active set.
    expect(resolveLoginDestination({
      isSystemAdmin: false,
      events: [{ id: "event_1" }, { id: "event_2" }],
      lastEventId: "event_9_no_longer_active",
    })).toBe(EVENT_PICKER_PATH);
  });

  it("sends staff with several events to the picker when nothing is remembered yet", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: false,
      events: [{ id: "event_1" }, { id: "event_2" }],
      lastEventId: null,
    })).toBe(EVENT_PICKER_PATH);
  });

  it("sends staff with no active event memberships to the safe no-access page, never an error", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: false,
      events: [],
    })).toBe(NO_EVENTS_PATH);
  });

  it("routes an account with no active event memberships the same way whether it is unassigned staff or, hypothetically, a club leader/attendee id — this page is never reached by the real attendee/club portal login, which is a separate flow entirely (#108 queue 1)", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: false,
      events: [],
      lastEventId: "event_from_an_unrelated_context",
    })).toBe(NO_EVENTS_PATH);
  });

  it("honors a validated returnTo target ahead of any role routing", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: true,
      events: [],
      returnTo: "/more/clubs?event=event_1",
    })).toBe("/more/clubs?event=event_1");
  });

  it("honors a validated returnTo target for multi-event staff, skipping the picker", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: false,
      events: [{ id: "event_1" }, { id: "event_2" }],
      lastEventId: null,
      returnTo: "/people?event=event_2",
    })).toBe("/people?event=event_2");
  });

  it("rejects an unsafe returnTo and falls back to role routing instead", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: true,
      events: [],
      returnTo: "https://evil.com/phish",
    })).toBe(SYSTEM_ADMIN_PATH);
  });

  it("rejects a protocol-relative returnTo", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: false,
      events: [{ id: "event_1" }],
      returnTo: "//evil.com",
    })).toBe("/overview?event=event_1");
  });

  it("rejects an empty returnTo and falls back to role routing", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: false,
      events: [],
      returnTo: "",
    })).toBe(NO_EVENTS_PATH);
  });

  it("rejects a returnTo pointed at an API route", () => {
    expect(resolveLoginDestination({
      isSystemAdmin: true,
      events: [],
      returnTo: "/api/admin/organizations/org_1",
    })).toBe(SYSTEM_ADMIN_PATH);
  });
});
