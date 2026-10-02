import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMoreDirectoryCards } from "@/components/staff-navigation";
import { eventPermissions } from "@/modules/access/permissions";
import {
  defaultModuleKeys,
  eventModuleCatalog,
  eventModuleKeys,
  hiddenModuleCardKeys,
  moduleApplies,
  type EventModuleContext,
  type EventModuleKey,
} from "@/modules/event-modules/catalog";

const general: EventModuleContext = { audience: "GENERAL" };
const club: EventModuleContext = { audience: "CLUB" };
const rankedGeneral: EventModuleContext = { audience: "GENERAL", hasRankedSeminars: true };
const none = new Set<EventModuleKey>();
const cardKeys: Record<EventModuleKey, string> = {
  honors: "honors",
  "event-patches": "event-patches",
  "club-assignments": "club-assignments",
  "seminar-assignments": "program-assignments",
  merchandise: "merchandise",
  "attendee-community": "community",
  "public-content": "event-content",
};

describe("event module catalog (#741)", () => {
  it("defines every key once, with a title, description, group, and the routes it gates", () => {
    expect(eventModuleCatalog.map((entry) => entry.key).sort()).toEqual([...eventModuleKeys].sort());
    for (const entry of eventModuleCatalog) {
      expect(entry.title.length).toBeGreaterThan(2);
      expect(entry.description.length).toBeGreaterThan(10);
      expect(["setup", "content-sales", "people-access", "reports"]).toContain(entry.launcherGroup);
      expect(entry.routes.length).toBeGreaterThan(0);
      expect(entry.cardKey).toBe(cardKeys[entry.key]);
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

  it("maps every module to a real More card", () => {
    const real = new Set(buildMoreDirectoryCards({ permissions: eventPermissions, clubOversight: true, clubEvent: true, isSystemAdmin: true, clubFormsAccess: true, eventQuery: "" }).map((card) => card.key));
    for (const entry of eventModuleCatalog) expect(real.has(entry.cardKey)).toBe(true);
  });

  it("starts a new event with public content, plus the club modules for a club audience", () => {
    expect(defaultModuleKeys("GENERAL")).toEqual(["public-content"]);
    expect(defaultModuleKeys("CLUB").sort()).toEqual(["club-assignments", "event-patches", "honors", "public-content"]);
  });

  it("hides an applicable module's card when it is off: visibility reads stored rows only", () => {
    expect(moduleApplies("honors", club)).toBe(true);
    expect([...hiddenModuleCardKeys(none, ["honors"])]).toEqual(["honors"]);
    expect([...hiddenModuleCardKeys(new Set(["honors"]), ["honors"])]).toEqual([]);
    expect([...hiddenModuleCardKeys(new Set(["merchandise"]), ["seminar-assignments"])]).toEqual(["program-assignments"]);
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

  it("hides the Honors Weekend builder when listed, and only that", () => {
    const before = allowedKeys();
    const after = allowedKeys(new Set(["honors"]));
    expect(before).toContain("honors");
    expect(after).not.toContain("honors");
    expect(after).toContain("club-forms");
    expect(after).toEqual(before.filter((key) => key !== "honors"));
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
