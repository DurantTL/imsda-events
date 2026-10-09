import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Honors clean-up (#819): voided entries leave the history list, the
 * type-to-search honor filter, the bulk popup's payload, the club print report
 * (honor names and counts only), the roster's button-only Honors cell, and the
 * Area Coordinator club search. Synthetic data only.
 */
const mocks = vi.hoisted(() => ({
  getRosterAccessStateForPage: vi.fn(),
  loadHonorsExport: vi.fn(),
  listExportMemberOptions: vi.fn(),
  getCurrentAttendee: vi.fn(),
  currentStaffActingContext: vi.fn(),
  attendeeSecondStepPending: vi.fn(),
  isAreaCoordinator: vi.fn(),
  listClubsForArea: vi.fn(),
  listDirectedClubs: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); }, notFound: vi.fn(), usePathname: () => "/" }));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));
vi.mock("@/modules/reporting/director-exports-repository", () => ({
  loadHonorsExport: mocks.loadHonorsExport,
  listExportMemberOptions: mocks.listExportMemberOptions,
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/portal-second-step", () => ({ attendeeSecondStepPending: mocks.attendeeSecondStepPending }));
vi.mock("@/modules/attendee-accounts/return-redirect", () => ({ attendeeSignInRedirectPath: async () => "/sign-in", twoStepRedirectPath: async () => "/two-step" }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));
vi.mock("@/modules/organizations/area-coordinators", () => ({ isAreaCoordinator: mocks.isAreaCoordinator, listClubsForArea: mocks.listClubsForArea }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));

import ClubHonorsReportPage from "@/app/(public)/account/(portal)/clubs/[organizationId]/exports/honors/page";
import MyClubsPage from "@/app/(public)/account/(portal)/clubs/page";
import { HonorCombobox } from "@/components/honor-combobox";
import { HonorsPrintReport } from "@/components/honors-print-report";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { filterClubsByNameChurchOrCity } from "@/modules/club-reports/area-summary-domain";
import { comboboxKeyResult, filterHonorsByWordPrefix, filterPeopleByWordPrefix } from "@/modules/honors/honor-search";
import { bulkHonorPayload, visibleHonorHistory, type MemberHonorEntryRecord } from "@/modules/honors/member-honor-domain";
import { bulkMemberHonorEntrySchema } from "@/modules/honors/member-honor-schemas";
import { clubHonorCounts, memberCompletedHonors, type HonorsExportRow } from "@/modules/reporting/director-exports";
import type { RosterMemberRecord } from "@/modules/club-rosters/repository";

const honors = ["Abseiling", "Abseiling - Advanced", "Abseiling - Instructor", "Aboriginal Lore", "Arab Culture", "Lab Safety", "Camping Skills I", "Knots"]
  .map((name, index) => ({ id: `h${index}`, name }));

describe("honor type-to-search (#819)", () => {
  it("matches from the start of any word: 'ab' finds the four, never Arab or Lab", () => {
    expect(filterHonorsByWordPrefix(honors, "ab").map((honor) => honor.name)).toEqual([
      "Abseiling", "Abseiling - Advanced", "Abseiling - Instructor", "Aboriginal Lore",
    ]);
  });

  it("ignores case, extra spaces and accents", () => {
    expect(filterHonorsByWordPrefix(honors, "  AB ").map((honor) => honor.name)).toHaveLength(4);
    expect(filterHonorsByWordPrefix([{ id: "x", name: "Café Skills" }], "cafe")).toHaveLength(1);
  });

  it("matches a later word, and needs every typed word to match", () => {
    expect(filterHonorsByWordPrefix(honors, "adv").map((honor) => honor.name)).toEqual(["Abseiling - Advanced"]);
    expect(filterHonorsByWordPrefix(honors, "abs inst").map((honor) => honor.name)).toEqual(["Abseiling - Instructor"]);
    expect(filterHonorsByWordPrefix(honors, "skills").map((honor) => honor.name)).toEqual(["Camping Skills I"]);
    expect(filterHonorsByWordPrefix(honors, "bseil")).toEqual([]);
  });

  it("treats an apostrophe as part of the word", () => {
    const named = [{ id: "a", name: "Hiker's Guide" }, { id: "b", name: "Hikers’ Camp" }];
    expect(filterHonorsByWordPrefix(named, "hikers").map((honor) => honor.id)).toEqual(["a", "b"]);
    expect(filterHonorsByWordPrefix(named, "hiker's g").map((honor) => honor.id)).toEqual(["a"]);
    expect(filterHonorsByWordPrefix(named, "s guide")).toEqual([]);
  });

  it("keeps everything for a blank search and never changes the input", () => {
    const input = [...honors];
    expect(filterHonorsByWordPrefix(input, "")).toHaveLength(honors.length);
    expect(filterHonorsByWordPrefix(input, undefined)).toHaveLength(honors.length);
    expect(input).toEqual(honors);
  });

  it("filters the bulk popup's members by the start of a first or last name word", () => {
    const people = [{ firstName: "Pat", lastName: "Fixture-A" }, { firstName: "Sam", lastName: "Patel" }, { firstName: "Lee", lastName: "Spat" }];
    expect(filterPeopleByWordPrefix(people, "pat").map((person) => person.lastName)).toEqual(["Fixture-A", "Patel"]);
  });
});

describe("honor combobox keyboard and markup (#819)", () => {
  it("opens with the arrows, wraps, chooses with Enter and closes with Escape", () => {
    expect(comboboxKeyResult("ArrowDown", { open: false, active: 0, count: 3 })).toMatchObject({ open: true, active: 0, handled: true });
    expect(comboboxKeyResult("ArrowDown", { open: true, active: 2, count: 3 })).toMatchObject({ open: true, active: 0 });
    expect(comboboxKeyResult("ArrowUp", { open: true, active: 0, count: 3 })).toMatchObject({ open: true, active: 2 });
    expect(comboboxKeyResult("Enter", { open: true, active: 1, count: 3 })).toMatchObject({ choose: true, active: 1, handled: true });
    expect(comboboxKeyResult("Escape", { open: true, active: 1, count: 3 })).toMatchObject({ open: false, handled: true });
  });

  it("leaves Enter and Escape alone while closed, so a form submits and a dialog closes", () => {
    expect(comboboxKeyResult("Enter", { open: false, active: 0, count: 3 })).toMatchObject({ choose: false, handled: false });
    expect(comboboxKeyResult("Escape", { open: false, active: 0, count: 3 })).toMatchObject({ handled: false });
    expect(comboboxKeyResult("Tab", { open: true, active: 0, count: 3 })).toMatchObject({ open: false, handled: false });
  });

  it("renders the combobox and listbox roles, closed, with an All honors choice for filters", () => {
    const html = renderToStaticMarkup(createElement(HonorCombobox, { allLabel: "All honors", label: "Honor", onChange: () => {}, options: honors, value: "" }));
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('value="All honors"');
    expect(html).toContain("<label");
  });

  it("shows the chosen honor and posts its id with a form", () => {
    const html = renderToStaticMarkup(createElement(HonorCombobox, { label: "Honor", name: "honorId", onChange: () => {}, options: honors, value: "h3" }));
    expect(html).toContain('value="Aboriginal Lore"');
    expect(html).toContain('type="hidden" name="honorId" value="h3"');
  });
});

describe("voided entries leave the history list (#819)", () => {
  const entry = (id: string, status: "IN_PROGRESS" | "COMPLETED", voided: boolean): MemberHonorEntryRecord => ({
    id, honorId: "h1", honorCode: "H1", honorName: "Fixture Honor", status, completionDate: "", note: "", recordedByName: "Dana",
    recordedAtOrganizationId: "org-1", recordedAtOrganizationName: "Fixture Club", createdAt: "2026-09-01T00:00:00Z",
    voided: voided ? { voidedByName: "Dana", voidedAt: "2026-09-02T00:00:00Z", reason: "synthetic" } : null,
  });

  it("hides a voided entry and the in-progress one a completion replaced", () => {
    const history = [entry("3", "COMPLETED", false), entry("2", "IN_PROGRESS", true), entry("1", "IN_PROGRESS", true)];
    expect(visibleHonorHistory(history).map((item) => item.id)).toEqual(["3"]);
  });

  it("shows nothing for a history of only voided entries, and does not change the stored list", () => {
    const history = [entry("1", "COMPLETED", true)];
    expect(visibleHonorHistory(history)).toEqual([]);
    expect(history).toHaveLength(1);
    expect(history[0]!.voided?.reason).toBe("synthetic");
  });
});

describe("the bulk popup's payload (#819)", () => {
  it("is exactly what the existing bulk endpoint accepts", () => {
    const payload = bulkHonorPayload({ memberIds: new Set(["m1", "m2"]), honorId: "h1", status: "COMPLETED", completionDate: "2026-09-01", note: "Synthetic note" });
    expect(payload).toEqual({ memberIds: ["m1", "m2"], honorId: "h1", status: "COMPLETED", completionDate: "2026-09-01", note: "Synthetic note" });
    expect(bulkMemberHonorEntrySchema.parse(payload).memberIds).toEqual(["m1", "m2"]);
  });

  it("sends no date with an in-progress entry, even if one was typed before the status changed", () => {
    const payload = bulkHonorPayload({ memberIds: ["m1"], honorId: "h1", status: "IN_PROGRESS", completionDate: "2026-09-01", note: "" });
    expect(payload.completionDate).toBe("");
    expect(bulkMemberHonorEntrySchema.safeParse(payload).success).toBe(true);
  });

  it("sends nothing the endpoint would refuse for an empty selection", () => {
    expect(bulkMemberHonorEntrySchema.safeParse(bulkHonorPayload({ memberIds: [], honorId: "h1", status: "IN_PROGRESS", completionDate: "", note: "" })).success).toBe(false);
  });
});

describe("the roster's Honors cell (#819)", () => {
  const member: RosterMemberRecord = {
    id: "m1", firstName: "Pat", lastName: "Pathfinder", attendeeType: "YOUTH", role: "", classLevel: null, gender: null,
    status: "ACTIVE", source: "DIRECTOR", age: 12, reportedAge: null, birthDateNeeded: false, updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const roster = (props: Partial<Parameters<typeof ClubRosterWorkspace>[0]>) => renderToStaticMarkup(createElement(ClubRosterWorkspace, {
    canSeeBirthDates: false, clubYear: "2026-27", initialMembers: [member], organizationId: "org-1", ...props,
  }));

  it("holds only the button: no honor pills and no Show all", () => {
    const html = roster({ honorsPopup: { canRecord: true } });
    expect(html).toContain('aria-label="Honors for Pat Pathfinder"');
    expect(html).not.toContain("honor-pill");
    expect(html).not.toContain("Show all");
  });

  it("links the button to the Honors page for staff, who have no popup", () => {
    const html = roster({ honorsHref: "/admin/organizations/org-1/club/honors" });
    expect(html).toContain('href="/admin/organizations/org-1/club/honors"');
    expect(html).toContain('aria-label="Honors for Pat Pathfinder"');
  });
});

describe("the club print report holds honor names and counts only (#819)", () => {
  const exportRow = (memberId: string, honorId: string, honorName: string, status: string, lastName: string): HonorsExportRow => ({
    memberId, honorId, lastName, firstName: "Pat", className: "Friend", honorName, category: "Nature", status,
    dateEarned: "2026-08-17", dateKind: status === "Completed" ? "Completed" : "Recorded", eventName: "Fixture Camporee",
  });
  const rows = [
    exportRow("m1", "h1", "Knots", "Completed", "Fixture-Aaa"),
    exportRow("m2", "h1", "Knots", "Completed", "Fixture-Bbb"),
    exportRow("m3", "h1", "Knots", "In progress", "Fixture-Ccc"),
    exportRow("m1", "h2", "Abseiling", "Completed", "Fixture-Aaa"),
  ];

  it("counts completed honors by name, most first, and carries nothing else", () => {
    const counts = clubHonorCounts(rows);
    expect(counts).toEqual([{ honorName: "Knots", count: 2 }, { honorName: "Abseiling", count: 1 }]);
    expect(Object.keys(counts[0]!).sort()).toEqual(["count", "honorName"]);
  });

  it("renders no member name and no date", () => {
    const html = renderToStaticMarkup(createElement(HonorsPrintReport, { clubName: "Fixture Club", clubYear: "2026-27", honors: clubHonorCounts(rows), scope: "CLUB" }));
    expect(html).toContain("Knots");
    expect(html).toContain("<td>2</td>");
    expect(html).not.toContain("Fixture-");
    expect(html).not.toContain("Pat");
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(html).not.toContain("Fixture Camporee");
  });

  it("lists one person's completed honors only", () => {
    expect(memberCompletedHonors(rows.filter((row) => row.memberId === "m1")).map((honor) => honor.honorName)).toEqual(["Abseiling", "Knots"]);
    expect(memberCompletedHonors(rows.filter((row) => row.memberId === "m3"))).toEqual([]);
  });

  describe("the page", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.getRosterAccessStateForPage.mockResolvedValue({ state: "OPEN", club: { name: "Fixture Club" } });
      mocks.loadHonorsExport.mockResolvedValue({ clubName: "Fixture Club", rows });
      mocks.listExportMemberOptions.mockResolvedValue([{ memberId: "m1", label: "Fixture-Aaa, Pat" }, { memberId: "m2", label: "Fixture-Bbb, Pat" }]);
    });
    const render = async (search: Record<string, string>) =>
      renderToStaticMarkup(await ClubHonorsReportPage({ params: Promise.resolve({ organizationId: "org-1" }), searchParams: Promise.resolve(search) }));

    it("whole club: honor names and counts, with no member name or date anywhere in the HTML", async () => {
      const html = await render({});
      expect(html).toContain("Knots");
      expect(html).toContain("Abseiling");
      expect(html).not.toContain("Fixture-");
      expect(html).not.toContain("2026-08-17");
      expect(html).not.toContain('name="member"');
      expect(html).not.toContain("Download CSV");
      expect(html).not.toContain("Category");
      expect(mocks.listExportMemberOptions).not.toHaveBeenCalled();
    });

    it("one person: asks for a member first, then prints that member's completed honors", async () => {
      const ask = await render({ view: "person" });
      expect(ask).toContain("Choose a member");
      expect(mocks.loadHonorsExport).not.toHaveBeenCalled();
      const report = await render({ view: "person", member: "m1" });
      expect(mocks.loadHonorsExport).toHaveBeenCalledWith("org-1", expect.any(String), { memberId: "m1" });
      expect(report).toContain("Completed honors:");
      expect(report).toContain("Fixture-Aaa, Pat");
    });

    it("controls (#827): one primary action, labelled Show report, with Print beside it, in both modes", async () => {
      const club = await render({});
      expect(club).toContain("honors-report-controls");
      expect(club).toContain("Club year");
      expect(club.match(/primary-button/g)).toHaveLength(1);
      expect(club).toContain("Show report");
      expect(club).toContain('report-print-button');
      expect(club).toMatch(/aria-current="page"[^>]*>Whole club</);
      expect(club).not.toMatch(/aria-current="page"[^>]*>One person</);
      const person = await render({ view: "person", member: "m1" });
      expect(person).toContain("Member");
      expect(person.match(/primary-button/g)).toHaveLength(1);
      expect(person).toContain("Show report");
      expect(person).toContain('report-print-button');
      expect(person).toMatch(/aria-current="page"[^>]*>One person</);
      expect(person).not.toMatch(/aria-current="page"[^>]*>Whole club</);
      const asking = await render({ view: "person" });
      expect(asking).not.toContain("report-print-button");
      expect(asking.match(/primary-button/g)).toHaveLength(1);
    });

    it("choosing a member or year shows the report at once, with Show report kept for no-JavaScript use (#851)", async () => {
      const person = await render({ view: "person", member: "m1" });
      expect(person).toMatch(/<form[^>]*aria-label="Report options"[^>]*method="get"/);
      expect(person).toContain('name="member"');
      expect(person).toMatch(/class="primary-button auto-submit-go"/);
      expect(person).toContain("Show report");
      expect(person).toContain('report-print-button');
    });

    it("one person: a member id that isn't on the club's list never reaches the export and asks for a member", async () => {
      const html = await render({ view: "person", member: "member-of-another-club" });
      expect(mocks.loadHonorsExport).not.toHaveBeenCalled();
      expect(html).toContain("Choose a member");
      expect(html).not.toContain("Knots");
    });
  });
});

describe("the Area Coordinator All clubs search (#819)", () => {
  const clubs = [
    { organizationId: "a", name: "Alpine Eagles", sponsoringChurch: "Fixture Valley Church", city: "Fixtureville" },
    { organizationId: "b", name: "Bay Trailblazers", sponsoringChurch: "Harbor Church", city: "Bayport" },
    { organizationId: "c", name: "Cedar Ridge", sponsoringChurch: null, city: null },
  ];

  it("matches the club name, the church or the city, ignoring case and extra spaces", () => {
    expect(filterClubsByNameChurchOrCity(clubs, "eagles").map((club) => club.organizationId)).toEqual(["a"]);
    expect(filterClubsByNameChurchOrCity(clubs, " HARBOR  church ").map((club) => club.organizationId)).toEqual(["b"]);
    expect(filterClubsByNameChurchOrCity(clubs, "bayport").map((club) => club.organizationId)).toEqual(["b"]);
    expect(filterClubsByNameChurchOrCity(clubs, "zzz")).toEqual([]);
  });

  it("keeps every club for a blank search and never changes the input", () => {
    const input = [...clubs];
    expect(filterClubsByNameChurchOrCity(input, "")).toHaveLength(3);
    expect(filterClubsByNameChurchOrCity(input, undefined)).toHaveLength(3);
    expect(input).toEqual(clubs);
  });

  describe("the page", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1" } });
      mocks.currentStaffActingContext.mockResolvedValue(null);
      mocks.attendeeSecondStepPending.mockResolvedValue(false);
      mocks.isAreaCoordinator.mockResolvedValue(true);
      mocks.listDirectedClubs.mockResolvedValue([]);
      mocks.listClubsForArea.mockResolvedValue(clubs);
    });
    const render = async (search: Record<string, string>) =>
      renderToStaticMarkup(await MyClubsPage({ searchParams: Promise.resolve(search) }));

    it("shows a search box and every club without a search", async () => {
      const html = await render({});
      expect(html).toContain('name="q"');
      expect(html).toContain("Alpine Eagles");
      expect(html).toContain("Cedar Ridge");
    });

    it("filters by church or city and says how many match", async () => {
      const html = await render({ q: "harbor" });
      expect(html).toContain("Bay Trailblazers");
      expect(html).not.toContain("Alpine Eagles");
      expect(html).toContain("1 of 3 clubs match");
      expect((await render({ q: "fixtureville" })).includes("Alpine Eagles")).toBe(true);
    });

    it("says so when nothing matches", async () => {
      expect(await render({ q: "nothing here" })).toContain("matches “nothing here”");
    });
  });
});
