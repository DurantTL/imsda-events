import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Club info (#644): profile section then team section, each behind its own capability; old routes redirect. Synthetic data only. */

const mocks = vi.hoisted(() => ({
  getRosterAccessStateForPage: vi.fn(),
  getClubProfile: vi.fn(),
  listChurchOptions: vi.fn(),
  listClubTeam: vi.fn(),
  listPendingClubTeamInvites: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));
vi.mock("@/modules/organizations/club-profile-repository", () => ({
  getClubProfile: mocks.getClubProfile,
  listChurchOptions: mocks.listChurchOptions,
}));
vi.mock("@/modules/organizations/director-grants-repository", () => ({ listClubTeam: mocks.listClubTeam }));
vi.mock("@/modules/club-imports/invites", () => ({ listPendingClubTeamInvites: mocks.listPendingClubTeamInvites }));

import ClubAwardsRedirect from "@/app/(public)/account/(portal)/clubs/[organizationId]/awards/page";
import ClubInfoPage from "@/app/(public)/account/(portal)/clubs/[organizationId]/club-info/page";
import ClubProfileRedirect from "@/app/(public)/account/(portal)/clubs/[organizationId]/profile/page";
import ClubTeamRedirect from "@/app/(public)/account/(portal)/clubs/[organizationId]/team/page";
import { ClubProfileForm } from "@/components/club-profile-form";
import { ClubTeamWorkspace } from "@/components/club-team-workspace";

type AnyProps = Record<string, unknown>;

function elements(node: ReactNode, found: ReactElement<AnyProps>[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found);
    return found;
  }
  if (!isValidElement<AnyProps>(node)) return found;
  found.push(node);
  elements(node.props.children as ReactNode, found);
  return found;
}

const params = { params: Promise.resolve({ organizationId: "club-1" }) };
const open = (editProfile: boolean, manageTeam: boolean) => ({
  state: "OPEN",
  club: { organizationId: "club-1", name: "Test Pathfinders", role: "DIRECTOR", sponsoringChurch: null },
  capabilities: { roster: true, registerForEvents: true, seeBirthDates: true, manageTeam, editProfile, submitReports: true },
  actor: { kind: "ATTENDEE", accountId: "account-1", sessionId: "session-1" },
});
const typesIn = (tree: ReactNode) => elements(tree).map((element) => element.type);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClubProfile.mockResolvedValue({ name: "Test Pathfinders", sponsoringChurchId: "church-1", updatedAt: null });
  mocks.listChurchOptions.mockResolvedValue([]);
  mocks.listClubTeam.mockResolvedValue([]);
  mocks.listPendingClubTeamInvites.mockResolvedValue([]);
});

describe("Club info page (#644)", () => {
  it("shows the profile and team together, profile first", async () => {
    mocks.getRosterAccessStateForPage.mockResolvedValue(open(true, true));
    const types = typesIn(await ClubInfoPage(params));
    expect(types).toContain(ClubProfileForm);
    expect(types.indexOf(ClubTeamWorkspace)).toBeGreaterThan(types.indexOf(ClubProfileForm));
  });

  it("shows only the profile when the viewer can edit the profile but not manage the team", async () => {
    mocks.getRosterAccessStateForPage.mockResolvedValue(open(true, false));
    const types = typesIn(await ClubInfoPage(params));
    expect(types).toContain(ClubProfileForm);
    expect(types).not.toContain(ClubTeamWorkspace);
    expect(mocks.listClubTeam).not.toHaveBeenCalled();
    expect(mocks.listPendingClubTeamInvites).not.toHaveBeenCalled();
  });

  it("shows only the team when the viewer can manage the team but not edit the profile", async () => {
    mocks.getRosterAccessStateForPage.mockResolvedValue(open(false, true));
    const types = typesIn(await ClubInfoPage(params));
    expect(types).toContain(ClubTeamWorkspace);
    expect(types).not.toContain(ClubProfileForm);
    expect(mocks.getClubProfile).not.toHaveBeenCalled();
  });

  it("tells a viewer with neither capability that only the director or deputy can change club settings", async () => {
    mocks.getRosterAccessStateForPage.mockResolvedValue(open(false, false));
    const tree = await ClubInfoPage(params);
    const types = typesIn(tree);
    expect(types).not.toContain(ClubProfileForm);
    expect(types).not.toContain(ClubTeamWorkspace);
    const paragraph = elements(tree).find((element) => element.type === "p" && element.props.className === "public-manage-empty");
    expect([paragraph?.props.children].flat().join("")).toContain("director or deputy");
    expect(mocks.getClubProfile).not.toHaveBeenCalled();
    expect(mocks.listClubTeam).not.toHaveBeenCalled();
  });

  it("renders nothing when the club isn't open to the viewer", async () => {
    mocks.getRosterAccessStateForPage.mockResolvedValue({ state: "NO_ROSTER", club: { name: "Test Pathfinders", role: "REPORTER" } });
    expect(await ClubInfoPage(params)).toBeNull();
  });
});

describe("old club routes redirect (#644)", () => {
  it("sends awards to class-tracking", async () => {
    await expect(ClubAwardsRedirect(params)).rejects.toThrow("REDIRECT /account/clubs/club-1/class-tracking");
  });
  it("sends profile to the club-info profile section", async () => {
    await expect(ClubProfileRedirect(params)).rejects.toThrow("REDIRECT /account/clubs/club-1/club-info#club-profile");
  });
  it("sends team to the club-info team section", async () => {
    await expect(ClubTeamRedirect(params)).rejects.toThrow("REDIRECT /account/clubs/club-1/club-info#club-team");
  });
});
