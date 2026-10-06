import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canSeeIssuesText,
  canSeeIssuesTextForAreaClub,
  clubInAreaCoordinatorScope,
} from "@/modules/background-checks/notes-access";

/**
 * Sterling Volunteers for Area Coordinators (#443): status, counts and the full
 * note for the adults of a club in scope; a director never gets the note.
 * Synthetic data only.
 */
const mocks = vi.hoisted(() => ({
  areaGrantFindUnique: vi.fn(),
  organizationFindUnique: vi.fn(),
  getCurrentAttendee: vi.fn(),
  accountNeedsSecondStep: vi.fn(),
  currentStaffActingContext: vi.fn(),
  resolveAreaGuardianViewer: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    areaCoordinatorGrant: { findUnique: mocks.areaGrantFindUnique },
    organization: { findUnique: mocks.organizationFindUnique },
  }),
}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: mocks.accountNeedsSecondStep }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));
vi.mock("@/modules/club-rosters/guardians-access", () => ({ resolveAreaGuardianViewer: mocks.resolveAreaGuardianViewer }));
vi.mock("@/components/club-guardians-panel", () => ({ ClubGuardiansPanel: () => null }));
vi.mock("@/components/club-overview", () => ({ ClubOverview: () => null }));

import AreaClubPage from "@/app/(public)/account/(portal)/area/[organizationId]/page";
import { ClubOverview } from "@/components/club-overview";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props?.children as ReactNode)];
}

const params = (organizationId: string) => ({ params: Promise.resolve({ organizationId }) });

async function overviewProps(organizationId = "club-1") {
  const tree = await AreaClubPage(params(organizationId));
  const overview = elements(tree).find((element) => element.type === ClubOverview);
  expect(overview).toBeDefined();
  return overview!.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "account-1" }, via: "attendee", sessionId: "s1" });
  mocks.areaGrantFindUnique.mockResolvedValue({ revokedAt: null, expiresAt: null });
  mocks.accountNeedsSecondStep.mockResolvedValue("OK");
  mocks.currentStaffActingContext.mockResolvedValue(null);
  mocks.resolveAreaGuardianViewer.mockResolvedValue(null);
  mocks.organizationFindUnique.mockResolvedValue({ type: "CLUB", isActive: true });
});

describe("the note's access rule (#427, #544, #443)", () => {
  it("lets an Area Coordinator see the note for a club in scope", () => {
    expect(canSeeIssuesTextForAreaClub({ areaCoordinatorActive: true }, { type: "CLUB", isActive: true })).toBe(true);
  });

  it("does not let an Area Coordinator see the note for a club outside their scope", () => {
    for (const club of [
      { type: "CLUB", isActive: false },
      { type: "CHURCH", isActive: true },
      { type: "CONFERENCE", isActive: true },
      { type: null, isActive: true },
      { type: "CLUB", isActive: null },
      null,
      undefined,
    ]) {
      expect(clubInAreaCoordinatorScope(club)).toBe(false);
      expect(canSeeIssuesTextForAreaClub({ areaCoordinatorActive: true }, club)).toBe(false);
    }
  });

  it("gives nothing to a viewer who is not an active Area Coordinator, even for a club in scope", () => {
    const club = { type: "CLUB", isActive: true };
    expect(canSeeIssuesTextForAreaClub({ areaCoordinatorActive: false }, club)).toBe(false);
    expect(canSeeIssuesTextForAreaClub(null, club)).toBe(false);
    expect(canSeeIssuesTextForAreaClub(undefined, club)).toBe(false);
  });

  it("never lets a club director or deputy see it: their role is not a global role, and their own roster passes includeNotes false", () => {
    for (const globalRole of ["DIRECTOR", "DEPUTY", "CLUB_DIRECTOR", "REGISTRAR", "AREA_COORDINATOR"]) {
      expect(canSeeIssuesText({ globalRole })).toBe(false);
    }
    const rosterRepository = readFileSync(path.join(process.cwd(), "modules/background-checks/repository.ts"), "utf8");
    const portal = rosterRepository.slice(rosterRepository.indexOf("export async function clubPortalComplianceStatuses"));
    expect(portal).toContain("{ includeNotes: false }");
    expect(portal).not.toContain("includeNotes: true");
    const directorPages = [
      "app/(public)/account/(portal)/clubs/[organizationId]/roster/page.tsx",
      "app/(public)/account/(portal)/clubs/[organizationId]/page.tsx",
    ];
    for (const page of directorPages) {
      const source = readFileSync(path.join(process.cwd(), page), "utf8");
      expect(source).not.toContain("includeNotes");
      expect(source).not.toContain("canSeeIssuesText");
    }
  });
});

describe("the Area Coordinator club page (#443)", () => {
  it("shows an active Area Coordinator the Sterling Volunteers status and the full note for a club in scope", async () => {
    const props = await overviewProps();
    expect(props.backgroundChecks).toEqual({ includeNotes: true });
    expect(props.organizationId).toBe("club-1");
    expect(props.reportsEditable).toBe(false);
  });

  it("checks the club server-side and shows nothing for a club outside their scope", async () => {
    for (const club of [null, { type: "CLUB", isActive: false }, { type: "CHURCH", isActive: true }]) {
      mocks.organizationFindUnique.mockResolvedValue(club);
      await expect(AreaClubPage(params("club-2"))).rejects.toThrow("NOT_FOUND");
    }
    expect(mocks.organizationFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "club-2" } }));
  });

  it.each([
    ["a non-coordinator", () => mocks.areaGrantFindUnique.mockResolvedValue(null)],
    ["a revoked grant", () => mocks.areaGrantFindUnique.mockResolvedValue({ revokedAt: new Date("2026-01-01"), expiresAt: null })],
    ["a signed-out visitor", () => mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null })],
  ])("returns not found for %s without loading the club", async (_label, arrange) => {
    arrange();
    await expect(AreaClubPage(params("club-1"))).rejects.toThrow("NOT_FOUND");
    expect(mocks.organizationFindUnique).not.toHaveBeenCalled();
  });

  it("does not ask for counts only any more: the per-adult status is the fuller view", () => {
    const source = readFileSync(path.join(process.cwd(), "app/(public)/account/(portal)/area/[organizationId]/page.tsx"), "utf8");
    expect(source).not.toContain("complianceCounts");
    expect(source).toContain("canSeeIssuesTextForAreaClub");
  });
});
