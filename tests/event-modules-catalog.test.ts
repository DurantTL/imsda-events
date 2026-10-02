import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMoreDirectoryCards } from "@/components/staff-navigation";
import { eventPermissions } from "@/modules/access/permissions";
import {
  clubFormsAvailable,
  eventModuleCatalog,
  eventModuleKeys,
  moduleApplies,
  moduleVisible,
  type EventModuleContext,
  type EventModuleKey,
} from "@/modules/event-modules/catalog";

const general: EventModuleContext = { audience: "GENERAL", hasRankedSeminars: false };
const club: EventModuleContext = { audience: "CLUB", hasRankedSeminars: false };
const rankedGeneral: EventModuleContext = { audience: "GENERAL", hasRankedSeminars: true };
const none = new Set<EventModuleKey>();

describe("event module catalog (#741)", () => {
  it("defines every key once, with a title, description, group, and the routes it gates", () => {
    expect(eventModuleCatalog.map((entry) => entry.key).sort()).toEqual([...eventModuleKeys].sort());
    for (const entry of eventModuleCatalog) {
      expect(entry.title.length).toBeGreaterThan(2);
      expect(entry.description.length).toBeGreaterThan(10);
      expect(["setup", "content-sales", "people-access", "reports"]).toContain(entry.launcherGroup);
      expect(entry.routes.length).toBeGreaterThan(0);
    }
  });

  it("applies the club modules only to club-audience events", () => {
    for (const key of ["honors", "event-patches", "club-assignments"] as const) {
      expect(moduleApplies(key, club)).toBe(true);
      expect(moduleApplies(key, general)).toBe(false);
      expect(moduleApplies(key, rankedGeneral)).toBe(false);
    }
  });

  it("applies seminar assignments to ranked-seminar events of either audience, not by audience", () => {
    expect(moduleApplies("seminar-assignments", rankedGeneral)).toBe(true);
    expect(moduleApplies("seminar-assignments", { audience: "CLUB", hasRankedSeminars: true })).toBe(true);
    expect(moduleApplies("seminar-assignments", general)).toBe(false);
    expect(moduleApplies("seminar-assignments", club)).toBe(false);
  });

  it("applies merchandise, community, and public content to any event; only public content is always on", () => {
    for (const key of ["merchandise", "attendee-community", "public-content"] as const) {
      expect(moduleApplies(key, general)).toBe(true);
      expect(moduleApplies(key, club)).toBe(true);
    }
    expect(eventModuleCatalog.filter((entry) => entry.alwaysOn).map((entry) => entry.key)).toEqual(["public-content"]);
  });

  it("shows an entry point when the module is on or applies, so existing data keeps its door", () => {
    expect(moduleVisible("honors", none, general)).toBe(false);
    expect(moduleVisible("honors", new Set(["honors"]), general)).toBe(true);
    expect(moduleVisible("honors", none, club)).toBe(true);
  });
});

describe("Club forms availability rule", () => {
  it("is available on club events and on any event with a club module on, never by default on general events", () => {
    expect(clubFormsAvailable(none, club)).toBe(true);
    expect(clubFormsAvailable(none, general)).toBe(false);
    for (const key of ["honors", "event-patches", "club-assignments"] as const) {
      expect(clubFormsAvailable(new Set([key]), general)).toBe(true);
    }
    expect(clubFormsAvailable(new Set(["merchandise", "seminar-assignments"]), general)).toBe(false);
  });
});

describe("entry points on the More directory", () => {
  const base = {
    permissions: eventPermissions,
    clubOversight: false,
    clubEvent: false,
    isSystemAdmin: true,
    clubFormsAccess: true,
    eventQuery: "?event=e1",
  };
  const allowedKeys = (hiddenCardKeys?: ReadonlySet<string>) =>
    buildMoreDirectoryCards({ ...base, hiddenCardKeys }).filter((card) => card.allowed).map((card) => card.key);

  it("hides the Honors Weekend builder and Club forms when listed, and only those", () => {
    const before = allowedKeys();
    const after = allowedKeys(new Set(["honors", "club-forms"]));
    expect(before).toContain("honors");
    expect(before).toContain("club-forms");
    expect(after).not.toContain("honors");
    expect(after).not.toContain("club-forms");
    expect(after).toEqual(before.filter((key) => key !== "honors" && key !== "club-forms"));
  });

  it("changes nothing when no key is hidden", () => {
    expect(buildMoreDirectoryCards({ ...base })).toEqual(buildMoreDirectoryCards({ ...base, hiddenCardKeys: new Set() }));
  });

  it("never grants: a hidden-set cannot turn a denied card on", () => {
    const denied = buildMoreDirectoryCards({ ...base, permissions: [], isSystemAdmin: false, clubFormsAccess: false, hiddenCardKeys: new Set() });
    expect(denied.filter((card) => card.allowed).map((card) => card.key)).not.toContain("honors");
  });
});

describe("route authorization is unchanged", () => {
  it("keeps module checks out of the gated pages and route handlers", () => {
    for (const path of [
      "../app/(workspace)/more/honors/page.tsx",
      "../app/(workspace)/more/club-forms/page.tsx",
      "../app/api/events/[eventId]/honors/rosters/route.ts",
      "../app/api/staff/club-forms/export/route.ts",
    ]) {
      expect(readFileSync(new URL(path, import.meta.url), "utf8")).not.toContain("event-modules");
    }
  });
});
