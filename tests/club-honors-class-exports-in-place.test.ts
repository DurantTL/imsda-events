import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRosterAccessStateForPage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); }, notFound: vi.fn(), usePathname: () => "/" }));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));

import ClubExportsPage from "@/app/(public)/account/(portal)/clubs/[organizationId]/exports/page";
import { ClubEarnedAwardsWorkspace, emptyEarnedAwardsData } from "@/components/club-earned-awards-workspace";
import { ClubHonorsWorkspace } from "@/components/club-honors-workspace";
import { ClubMemberHonorsDialog } from "@/components/club-member-honors-dialog";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import {
  bulkHonorButtonState,
  clubHonorsEmptyCopy,
  clubHonorsEmptyState,
  currentHonorsFromHistory,
  memberHonorsDialogMode,
  type ClubHonorsRow,
} from "@/modules/honors/member-honor-domain";
import type { RosterMemberRecord } from "@/modules/club-rosters/repository";

/** Honors and class exports in place, the roster honors popup, and the Honors page empty states (#701). Synthetic data only. */

const row = (id: string, honors: ClubHonorsRow["honors"] = []): ClubHonorsRow => ({
  memberId: id, firstName: "Pat", lastName: `Fixture-${id}`, classLevel: null, honors,
});
const honor = { honorId: "h1", honorCode: "H1", honorName: "Fixture Honor", status: "COMPLETED" as const, completionDate: "2026-09-01", createdAt: "2026-09-01T00:00:00Z" };

function honorsMarkup(props: Partial<Parameters<typeof ClubHonorsWorkspace>[0]>) {
  return renderToStaticMarkup(createElement(ClubHonorsWorkspace, {
    organizationId: "org-1", clubYear: "2026-27", initialRows: [], honorOptions: [{ id: "h1", code: "H1", name: "Fixture Honor" }], ...props,
  }));
}

describe("the old Honors & class reports page", () => {
  it("redirects to the club's Honors page, which checks its own access", async () => {
    await expect(ClubExportsPage({ params: Promise.resolve({ organizationId: "org-1" }) })).rejects.toThrow("REDIRECT /account/clubs/org-1/honors");
    expect(mocks.getRosterAccessStateForPage).not.toHaveBeenCalled();
  });
});

describe("exports in their new homes", () => {
  it("puts the honors export on the Honors page, pointing at the existing export route", () => {
    const html = honorsMarkup({ initialRows: [row("a", [honor])] });
    expect(html).toContain('href="/api/attendee/clubs/org-1/exports/honors"');
    expect(html).toContain("/account/clubs/org-1/exports/honors");
    expect(html).toContain("Export CSV");
  });

  it("a read-only viewer gets the CSV (the route allows an Area Coordinator) but not the club-only printable page; staff get neither", () => {
    const readOnly = honorsMarkup({ readOnly: true, initialRows: [row("a", [honor])] });
    expect(readOnly).toContain("/exports/honors");
    expect(readOnly).not.toContain("Print report");
    expect(honorsMarkup({ staff: true, readOnly: true, initialRows: [row("a")] })).not.toContain("Export CSV");
  });

  it("puts the class export on the Class tracking page, pointing at the existing export route", () => {
    const html = renderToStaticMarkup(createElement(ClubEarnedAwardsWorkspace, {
      initial: emptyEarnedAwardsData,
      organizationId: "org-1",
      ordersHref: "/account/clubs/org-1/orders",
      exportCsvHref: "/api/attendee/clubs/org-1/exports/class-tracking",
      exportPrintHref: "/account/clubs/org-1/exports/class-tracking",
    }));
    expect(html).toContain('href="/api/attendee/clubs/org-1/exports/class-tracking"');
    expect(html).toContain('href="/account/clubs/org-1/exports/class-tracking"');
  });

  it("offers no class export where none is passed (the Area Coordinator view)", () => {
    const html = renderToStaticMarkup(createElement(ClubEarnedAwardsWorkspace, {
      initial: emptyEarnedAwardsData, organizationId: "org-1", ordersHref: "/o", readOnly: true,
    }));
    expect(html).not.toContain("Export CSV");
  });
});

describe("Honors page empty states (D4) and labels (D3)", () => {
  it("picks one state per situation", () => {
    expect(clubHonorsEmptyState([], [])).toBe("NO_MEMBERS");
    expect(clubHonorsEmptyState([row("a")], [])).toBe("NO_MATCH");
    expect(clubHonorsEmptyState([row("a")], [row("a")])).toBe("NO_HONORS");
    expect(clubHonorsEmptyState([row("a", [honor])], [row("a", [honor])])).toBeNull();
  });

  it("renders its own copy for each", () => {
    expect(honorsMarkup({ initialRows: [] })).toContain("No members on the roster yet");
    const noHonors = honorsMarkup({ initialRows: [row("a")] });
    expect(noHonors).toContain(clubHonorsEmptyCopy.NO_HONORS);
    expect(noHonors).not.toContain("No one matches these filters.");
    expect(honorsMarkup({ initialRows: [row("a", [honor])] })).not.toContain("No honors recorded yet");
  });

  it("renames Unit to Current class", () => {
    const html = honorsMarkup({ initialRows: [row("a", [honor])] });
    expect(html).toContain("Current class");
    expect(html).toContain("All classes");
    expect(html).not.toContain("All units");
  });

  it("labels the bulk button and explains why it is disabled at 0", () => {
    expect(bulkHonorButtonState(0, true)).toEqual({ label: "Record honor for 0 selected", disabledReason: "Tick at least one member." });
    expect(bulkHonorButtonState(3, false)).toEqual({ label: "Record honor for 3 selected", disabledReason: "Choose an honor." });
    expect(bulkHonorButtonState(3, true).disabledReason).toBe("");
    // The bulk form is a popup now (#819): the page only offers the button that opens it.
    const html = honorsMarkup({ initialRows: [row("a", [honor])] });
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>.*Add honors to several members/);
    expect(html).not.toContain("Record honor for 0 selected");
    expect(html).not.toContain("Select all shown");
    expect(html).not.toContain('type="checkbox"');
  });
});

describe("the roster's per-person honors popup", () => {
  const member: RosterMemberRecord = {
    id: "m1", firstName: "Pat", lastName: "Pathfinder", attendeeType: "YOUTH", role: "", classLevel: null, gender: null,
    status: "ACTIVE", source: "DIRECTOR", age: 12, reportedAge: null, birthDateNeeded: false, updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const roster = (props: Partial<Parameters<typeof ClubRosterWorkspace>[0]>) => renderToStaticMarkup(createElement(ClubRosterWorkspace, {
    canSeeBirthDates: false, clubYear: "2026-27", initialMembers: [member], organizationId: "org-1", ...props,
  }));

  it("replaces the Open Honors link with a per-row button", () => {
    const html = roster({ honorsPopup: { canRecord: true } });
    expect(html).toContain('aria-label="Honors for Pat Pathfinder"');
    expect(html).not.toContain("Open Honors tab");
    expect(roster({})).not.toContain("Honors for Pat Pathfinder");
  });

  it("decides record, view-only or load error from the page and the Honors list", () => {
    expect(memberHonorsDialogMode(true, { ok: true, readOnly: false })).toBe("RECORD");
    expect(memberHonorsDialogMode(true, { ok: true, readOnly: true })).toBe("VIEW_ONLY");
    expect(memberHonorsDialogMode(false, null)).toBe("VIEW_ONLY");
    expect(memberHonorsDialogMode(false, { ok: true, readOnly: false })).toBe("VIEW_ONLY");
    expect(memberHonorsDialogMode(true, { ok: false, readOnly: false })).toBe("LOAD_ERROR");
    expect(memberHonorsDialogMode(true, null)).toBe("LOAD_ERROR");
  });

  it("shows an honor once, at its latest non-voided status", () => {
    const entry = (id: string, status: "IN_PROGRESS" | "COMPLETED", voided = false) => ({
      id, honorId: "h1", honorCode: "H1", honorName: "Fixture Honor", status, completionDate: status === "COMPLETED" ? "2026-09-01" : "",
      note: "", recordedByName: "Dana", recordedAtOrganizationId: "org-1", recordedAtOrganizationName: "Fixture", createdAt: "2026-09-01T00:00:00Z",
      voided: voided ? { voidedByName: "Dana", voidedAt: "2026-09-02T00:00:00Z", reason: "synthetic" } : null,
    });
    // Newest first, as the repository returns it.
    const current = currentHonorsFromHistory([entry("3", "COMPLETED"), entry("2", "IN_PROGRESS"), entry("1", "IN_PROGRESS")] as never);
    expect(current).toHaveLength(1);
    expect(current[0]!.status).toBe("COMPLETED");
    expect(currentHonorsFromHistory([entry("3", "COMPLETED", true), entry("2", "IN_PROGRESS")] as never)[0]!.status).toBe("IN_PROGRESS");
  });

  it("offers no record form when the page says the role can't record", () => {
    const html = renderToStaticMarkup(createElement(ClubMemberHonorsDialog, {
      organizationId: "org-1", member: { id: "m1", firstName: "Pat", lastName: "Pathfinder" }, canRecord: false, onClose: () => {},
    }));
    expect(html).not.toContain("Record honor");
  });
});
