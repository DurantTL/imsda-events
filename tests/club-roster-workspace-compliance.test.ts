import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClubRosterWorkspace, type RosterComplianceInfo } from "@/components/club-roster-workspace";
import type { RosterMemberRecord } from "@/modules/club-rosters/repository";

/**
 * Compliance reminders and the roster's `?compliance=` filter (#479). This
 * environment renders React without a DOM (see vitest.config.ts), so the
 * initial-render markup is what's asserted: exactly what a director,
 * registrar, or someone who followed a "What's next" reminder link sees.
 */

function member(id: string, overrides: Partial<RosterMemberRecord> = {}): RosterMemberRecord {
  return {
    id,
    firstName: "Pat",
    lastName: `Pathfinder-${id}`,
    attendeeType: "ADULT",
    role: "",
    classLevel: null,
    gender: null,
    status: "ACTIVE",
    source: "DIRECTOR",
    age: 30,
    reportedAge: null,
    birthDateNeeded: false,
    updatedAt: new Date("2026-09-01T00:00:00Z").toISOString(),
    ...overrides,
  };
}

const members: RosterMemberRecord[] = [
  member("missing-check"),
  member("expired-check"),
  member("current-check"),
];

const complianceStatuses: Record<string, RosterComplianceInfo> = {
  "missing-check": { state: "NO_RECORD", note: null },
  "expired-check": { state: "NOT_COMPLIANT", note: null },
  "current-check": { state: "CLEAR", note: null },
};

function markup(props: Partial<Parameters<typeof ClubRosterWorkspace>[0]>) {
  return renderToStaticMarkup(createElement(ClubRosterWorkspace, {
    canSeeBirthDates: false,
    clubYear: "2026",
    initialMembers: members,
    organizationId: "org-1",
    readOnly: true,
    ...props,
  }));
}

describe("club roster background-check column visibility (#427, #479)", () => {
  it("shows the Background check column for a role that gets compliance statuses (director)", () => {
    const html = markup({ complianceStatuses });
    expect(html).toContain("Background check");
    expect(html).toContain("Not in compliance");
  });

  it("shows no Background check column at all for a role without it (a registrar)", () => {
    const html = markup({ complianceStatuses: undefined });
    expect(html).not.toContain("Background check");
    expect(html).not.toContain("Not in compliance");
  });
});

describe("roster ?compliance= filter from a What's next / club overview reminder link (#479)", () => {
  it("narrows the roster to only people missing a current background check", () => {
    const html = markup({ complianceStatuses, complianceFilter: "missing" });
    expect(html).toContain("Showing only people missing a current background check.");
    expect(html).toContain("Pathfinder-missing-check");
    expect(html).not.toContain("Pathfinder-expired-check");
    expect(html).not.toContain("Pathfinder-current-check");
  });

  it("narrows the roster to only people expired or not in compliance", () => {
    const html = markup({ complianceStatuses, complianceFilter: "expired" });
    expect(html).toContain("Pathfinder-expired-check");
    expect(html).not.toContain("Pathfinder-missing-check");
    expect(html).not.toContain("Pathfinder-current-check");
  });

  it("is a no-op, and shows no filter notice, for a role that never received compliance statuses", () => {
    const html = markup({ complianceStatuses: undefined, complianceFilter: "missing" });
    expect(html).not.toContain("Showing only people");
    expect(html).toContain("Pathfinder-missing-check");
    expect(html).toContain("Pathfinder-expired-check");
    expect(html).toContain("Pathfinder-current-check");
  });
});
