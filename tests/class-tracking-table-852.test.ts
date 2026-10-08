import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ClubEarnedAwardsWorkspace, emptyEarnedAwardsData, filterMembers } from "@/components/club-earned-awards-workspace";

/** The Class tracking page rebuilt to match the Honors page (#852). Synthetic data only. */
const members = [
  { personId: "p1", firstName: "Alex", lastName: "Sample", classLabel: "Friend", completed: { FRIEND: "2027-01-05" } },
  { personId: "p2", firstName: "Casey", lastName: "Demo", classLabel: "Guide", completed: {} },
  { personId: "p3", firstName: "Blair", lastName: "Trial", classLabel: "Friend" },
];
const base = "/account/clubs/club-1/class-tracking";
const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(ClubEarnedAwardsWorkspace, {
  organizationId: "club-1", ordersHref: "/o", classHistoryBase: base, initial: { ...emptyEarnedAwardsData, members }, ...extra,
} as never));

describe("class tracking members table (#852)", () => {
  it("mirrors the Honors page: heading, filters row, one responsive table", () => {
    const html = render();
    expect(html).toContain("public-manage-card");
    expect(html).toContain('id="class-tracking-heading"');
    expect(html).toContain("club-roster-tools");
    expect(html).toContain("Find a member");
    expect(html).toContain('role="combobox"');
    expect(html).toContain("Status for Friend");
    expect(html).toContain("table-cards class-tracking-table");
    expect(html).toContain("data-fit-width");
    expect(html).toContain("Current class");
  });

  it("lists each member once, with the class status and one history link per row", () => {
    const html = render();
    expect(html.match(/<table/g)).toHaveLength(1);
    for (const name of ["Sample, Alex", "Demo, Casey", "Trial, Blair"]) expect(html.match(new RegExp(`${name}<`, "g"))).toHaveLength(1);
    expect(html).toContain("Completed Jan 5, 2027");
    expect(html.match(/Not recorded/g)).toHaveLength(2);
    for (const id of ["p1", "p2", "p3"]) expect(html.split(`href="${base}/${id}"`).length - 1).toBe(1);
    expect(html).not.toContain("Add by hand</h3><p class=\"field-help\"><strong>Members");
  });

  it("keeps Mark completed and Add by hand, working on the table's selection", () => {
    const html = render({ initial: { ...emptyEarnedAwardsData, members, catalog: [{ itemId: "gc", section: "MISCELLANEOUS", sectionLabel: "Miscellaneous", name: "Good Conduct Bar", catalogNumber: "002304" }] } });
    expect(html).toContain("Mark completed");
    expect(html).toContain("Add by hand");
    expect(html).toContain("selected in the table above");
    expect(html.match(/type="checkbox"/g)?.length).toBe(members.length + 1); // one per member, plus "They already have it"
  });

  it("shows no member table and no actions to a view-only visitor", () => {
    const html = render({ readOnly: true, initial: { ...emptyEarnedAwardsData } });
    expect(html).not.toContain("class-tracking-table");
    expect(html).not.toContain("Mark completed");
    expect(html).toContain("View only");
  });

  it("filters by the chosen class's status as well as the search", () => {
    expect(filterMembers(members, "", "", "FRIEND").map((m) => m.personId)).toEqual(["p1", "p2", "p3"]);
    expect(filterMembers(members, "", "COMPLETED", "FRIEND").map((m) => m.personId)).toEqual(["p1"]);
    expect(filterMembers(members, "", "NOT_COMPLETED", "FRIEND").map((m) => m.personId)).toEqual(["p2", "p3"]);
    expect(filterMembers(members, "", "COMPLETED", "GUIDE")).toEqual([]);
    expect(filterMembers(members, "friend", "NOT_COMPLETED", "FRIEND").map((m) => m.personId)).toEqual(["p3"]);
  });

  it("styles the table to fit 601-1024px like the Honors table", () => {
    const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
    expect(css).toContain(".class-tracking-table { table-layout: fixed; width: 100%; }");
  });
});
