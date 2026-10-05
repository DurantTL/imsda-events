import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), notFound: vi.fn(), redirect: vi.fn() }));

import { ClubEarnedAwardsWorkspace, emptyEarnedAwardsData } from "@/components/club-earned-awards-workspace";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import type { RosterMemberRecord } from "@/modules/club-rosters/repository";

/**
 * The "Class history" link (#791) is opt-in: the page it opens is on the club
 * portal's gate, so the read-only area-coordinator and staff views must not
 * show a link that would 404. Synthetic names only.
 */
const base = "/account/clubs/club-1/class-tracking";

const member: RosterMemberRecord = {
  id: "m1", personId: "person-1", firstName: "Pat", lastName: "Sample", attendeeType: "YOUTH", role: "", classLevel: "FRIEND", gender: null,
  status: "ACTIVE", source: "DIRECTOR", age: 11, reportedAge: null, birthDateNeeded: false, updatedAt: "2026-09-01T00:00:00.000Z",
};

const roster = (extra: Record<string, unknown>) => renderToStaticMarkup(createElement(ClubRosterWorkspace, {
  clubYear: "2026-27", initialMembers: [member], organizationId: "club-1", canSeeBirthDates: false, ...extra,
} as never));

describe("roster class history link", () => {
  it("shows for the club portal roster, which passes the address", () => {
    const html = roster({ classHistoryBase: base });
    expect(html).toContain(`href="${base}/person-1"`);
    expect(html).toContain("Class history");
  });

  it("is absent on the read-only area and staff views, which do not pass it", () => {
    const html = roster({ readOnly: true });
    expect(html).not.toContain("Class history");
    expect(html).not.toContain("class-tracking");
  });

  it("is absent when the record carries no person id", () => {
    expect(roster({ classHistoryBase: base, initialMembers: [{ ...member, personId: undefined }] })).not.toContain("Class history");
  });
});

describe("class tracking class history links", () => {
  const needs = [
    { needId: "n1", personId: "person-1", firstName: "Pat", lastName: "Sample", itemName: "Friend Pin", origin: "Class", missingCatalogNumber: false, status: "NEEDED" as const },
    { needId: "n2", personId: "person-1", firstName: "Pat", lastName: "Sample", itemName: "Friend Patch", origin: "Class", missingCatalogNumber: false, status: "NEEDED" as const },
    { needId: "n3", personId: "person-2", firstName: "Sam", lastName: "Sample", itemName: "Good Conduct Bar", origin: "Manual", missingCatalogNumber: false, status: "ORDERED" as const },
  ];
  const render = (extra: Record<string, unknown>) => renderToStaticMarkup(createElement(ClubEarnedAwardsWorkspace, {
    organizationId: "club-1", ordersHref: "/o", readOnly: true,
    initial: { ...emptyEarnedAwardsData, needs, members: [{ personId: "person-1", firstName: "Pat", lastName: "Sample", classLabel: "Friend" }] },
    ...extra,
  } as never));

  it("shows one link per person in the open items, and one on the member list", () => {
    const html = render({ classHistoryBase: base, readOnly: false });
    expect(html.split(`href="${base}/person-1"`).length - 1).toBe(2); // open items (once) + member list
    expect(html.split(`href="${base}/person-2"`).length - 1).toBe(1);
  });

  it("hides the link for someone who has moved to another club", () => {
    const html = render({
      classHistoryBase: base,
      initial: { ...emptyEarnedAwardsData, needs: needs.map((need) => (need.personId === "person-2" ? { ...need, classHistoryHidden: true } : need)) },
    });
    expect(html).toContain(`href="${base}/person-1"`);
    expect(html).not.toContain(`${base}/person-2`);
  });

  it("the club roster page drops the person id of moved members before the link can show", () => {
    const page = readFileSync(path.join(process.cwd(), "app/(public)/account/(portal)/clubs/[organizationId]/roster/page.tsx"), "utf8");
    expect(page).toContain("personIdsMovedToOtherClubs");
    expect(page).toContain("personId: undefined");
    expect(page).toContain("initialMembers={linkableMembers}");
  });

  it("shows none on the area view, which does not pass the address", () => {
    const html = render({});
    expect(html).not.toContain("Class history");
  });

  it("only the club portal pages pass the address and the area and staff views do not", () => {
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
    expect(read("app/(public)/account/(portal)/clubs/[organizationId]/roster/page.tsx")).toContain("classHistoryBase");
    expect(read("app/(public)/account/(portal)/clubs/[organizationId]/class-tracking/page.tsx")).toContain("classHistoryBase");
    expect(read("app/(public)/account/(portal)/area/[organizationId]/awards/page.tsx")).not.toContain("classHistoryBase");
    const overview = read("components/club-overview.tsx");
    expect(overview).not.toContain("classHistoryBase");
    // The person id is also kept off the read-only view's client props.
    expect(overview).toContain("personId: undefined");
  });
});
