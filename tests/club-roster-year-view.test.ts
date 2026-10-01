import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The club roster's `?year=` view (#541). Every roster write route (add,
 * CSV import, edit, remove), the birth-date reveal, and transfers work on
 * the current club year, so a previous or next year must be read-only: a
 * write from it would swap the table to the current year under the old
 * label, and the next Remove would erase a current-year member.
 */

const mocks = vi.hoisted(() => ({
  getRosterAccessStateForPage: vi.fn(),
  clubPortalComplianceStatuses: vi.fn(),
  listRoster: vi.fn(),
  listClubHonorsPage: vi.fn(),
  listTransferClubOptions: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));
vi.mock("@/modules/background-checks/repository", () => ({ clubPortalComplianceStatuses: mocks.clubPortalComplianceStatuses }));
vi.mock("@/modules/club-rosters/repository", () => ({ listRoster: mocks.listRoster }));
vi.mock("@/modules/honors/member-honor-repository", () => ({ listClubHonorsPage: mocks.listClubHonorsPage }));
vi.mock("@/modules/club-transfers/repository", () => ({ listTransferClubOptions: mocks.listTransferClubOptions }));

import ClubRosterPage from "@/app/(public)/account/(portal)/clubs/[organizationId]/roster/page";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { ClubTransfersPanel } from "@/components/club-transfers-panel";
import { rosterYearView } from "@/modules/club-rosters/domain";
import type { RosterMemberRecord } from "@/modules/club-rosters/repository";

type AnyProps = Record<string, unknown>;

function componentElements(node: ReactNode, found: ReactElement<AnyProps>[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) componentElements(child, found);
    return found;
  }
  if (!isValidElement<AnyProps>(node)) return found;
  if (typeof node.type === "function") found.push(node);
  componentElements(node.props.children as ReactNode, found);
  return found;
}

const member: RosterMemberRecord = {
  id: "member-1",
  firstName: "Robin",
  lastName: "Fixture",
  attendeeType: "YOUTH",
  role: "Pathfinder",
  classLevel: "FRIEND",
  gender: null,
  status: "ACTIVE",
  source: "IMPORT",
  age: null,
  reportedAge: 10,
  birthDateNeeded: true,
  updatedAt: new Date("2026-09-01T00:00:00Z").toISOString(),
};

async function renderPage(year?: string) {
  const tree = await ClubRosterPage({
    params: Promise.resolve({ organizationId: "club-1" }),
    searchParams: Promise.resolve(year === undefined ? {} : { year }),
  });
  const elements = componentElements(tree);
  const workspace = elements.find((element) => element.type === ClubRosterWorkspace);
  expect(workspace).toBeDefined();
  expect(workspace!.key).toBe(workspace!.props.clubYear);
  return { html: renderToStaticMarkup(tree), elements, workspace: workspace!.props };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T15:00:00Z"));
  mocks.getRosterAccessStateForPage.mockResolvedValue({
    state: "OPEN",
    club: { organizationId: "club-1", name: "Fixture Pathfinders", role: "DIRECTOR", sponsoringChurch: null },
    capabilities: { roster: true, manageTeam: true, seeBirthDates: true },
    actor: { kind: "ATTENDEE", accountId: "director-1", sessionId: "session-1" },
  });
  mocks.clubPortalComplianceStatuses.mockResolvedValue(null);
  mocks.listRoster.mockResolvedValue([member]);
  mocks.listClubHonorsPage.mockResolvedValue([]);
  mocks.listTransferClubOptions.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("which club year a roster shows (#541)", () => {
  const now = new Date("2026-09-28T15:00:00Z");

  it("shows the previous or next year read-only, and the current year editable", () => {
    expect(rosterYearView("2025-26", now)).toMatchObject({ clubYear: "2025-26", currentClubYear: "2026-27", readOnly: true });
    expect(rosterYearView("2027-28", now)).toMatchObject({ clubYear: "2027-28", readOnly: true });
    expect(rosterYearView("2026-27", now)).toMatchObject({ clubYear: "2026-27", readOnly: false });
    expect(rosterYearView(undefined, now)).toMatchObject({ clubYear: "2026-27", readOnly: false });
    expect(rosterYearView("2026-27", now).choices).toEqual(["2025-26", "2026-27", "2027-28"]);
  });

  it("falls back to the current year for anything else", () => {
    for (const bad of ["2024-25", "2028-29", "2025-27", "junk", "", ["2025-26", "2027-28"]]) {
      expect(rosterYearView(bad, now)).toMatchObject({ clubYear: "2026-27", readOnly: false });
    }
  });
});

describe("the club roster page's ?year= view (#541)", () => {
  it("an old year offers no edit, import, remove, birth-date, or transfer control", async () => {
    const { html, elements, workspace } = await renderPage("2025-26");
    expect(mocks.listRoster).toHaveBeenCalledWith("club-1", "2025-26");
    expect(workspace).toMatchObject({ clubYear: "2025-26", readOnly: true, canSeeBirthDates: false, headingActions: undefined, honorsPopup: { canRecord: false } });
    expect(elements.some((element) => element.type === ClubTransfersPanel)).toBe(false);

    expect(html).toContain("Club year 2025-26");
    expect(html).toContain("Robin");
    expect(html).toMatch(/Showing the 2025-26 roster, read-only/);
    // Nothing on the page can reach a current-year write route.
    expect(html).not.toContain("Add to roster");
    expect(html).not.toMatch(/aria-label="Edit /);
    expect(html).not.toMatch(/aria-label="Remove /);
    expect(html).not.toContain("Show birth dates");
    expect(html).not.toMatch(/Import (a )?CSV|roster-csv-actions/i);
    expect(html).not.toMatch(/Request a transfer/i);
    expect(html).not.toContain("<form");
  });

  it("the current year keeps every control", async () => {
    const { html, workspace } = await renderPage();
    expect(mocks.listRoster).toHaveBeenCalledWith("club-1", "2026-27");
    expect(workspace).toMatchObject({ clubYear: "2026-27", readOnly: false, canSeeBirthDates: true });
    expect(html).toContain("Add to roster");
    expect(html).toMatch(/aria-label="Edit Robin Fixture"/);
    expect(html).toMatch(/aria-label="Remove Robin Fixture"/);
    expect(html).toContain("Show birth dates");
    expect(html).toContain("roster-csv-actions");
    expect(html).toContain("Request a transfer");
    expect(html).not.toMatch(/read-only/);
  });

  it("an invalid year falls back to the current, editable year", async () => {
    const { workspace } = await renderPage("1999-00");
    expect(mocks.listRoster).toHaveBeenCalledWith("club-1", "2026-27");
    expect(workspace).toMatchObject({ clubYear: "2026-27", readOnly: false });
  });
});
