import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRosterAccessStateForPage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));
vi.mock("@/modules/background-checks/repository", () => ({ clubPortalComplianceStatuses: vi.fn().mockResolvedValue(null) }));
vi.mock("@/modules/club-rosters/repository", () => ({ listRoster: vi.fn().mockResolvedValue([]) }));
vi.mock("@/modules/honors/member-honor-repository", () => ({ listClubHonorsPage: vi.fn().mockResolvedValue([]) }));
vi.mock("@/modules/club-transfers/repository", () => ({ listTransferClubOptions: vi.fn().mockResolvedValue([]) }));

import ClubRosterPage from "@/app/(public)/account/(portal)/clubs/[organizationId]/roster/page";
import { BackLink } from "@/components/back-link";

type AnyProps = Record<string, unknown>;

function backLinks(node: ReactNode, found: ReactElement<AnyProps>[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) backLinks(child, found);
    return found;
  }
  if (!isValidElement<AnyProps>(node)) return found;
  if (node.type === BackLink) found.push(node);
  backLinks(node.props.children as ReactNode, found);
  return found;
}

async function hrefs(returnTo: string | string[] | undefined) {
  const tree = await ClubRosterPage({
    params: Promise.resolve({ organizationId: "club-1" }),
    searchParams: Promise.resolve(returnTo === undefined ? {} : { returnTo }),
  });
  return backLinks(tree).map((link) => link.props.href);
}

beforeEach(() => {
  mocks.getRosterAccessStateForPage.mockResolvedValue({
    state: "OPEN",
    club: { organizationId: "club-1", name: "Fixture Pathfinders", role: "DIRECTOR", sponsoringChurch: null },
    capabilities: { roster: true, manageTeam: false, seeBirthDates: true },
    actor: { kind: "ATTENDEE", accountId: "director-1", sessionId: "session-1" },
  });
});

describe("roster page Back to registration (#643)", () => {
  it("shows the link for this club's registration path", async () => {
    expect(await hrefs("/account/clubs/club-1/events/event-1")).toEqual(["/account/clubs/club-1", "/account/clubs/club-1/events/event-1"]);
  });

  it.each([
    undefined,
    "/account/clubs/club-2/events/event-1",
    "/account/clubs/club-1",
    "https://evil.test/account/clubs/club-1/events/event-1",
    ["/account/clubs/club-1/events/event-1", "/x"],
  ])("shows only the club link for %s", async (value) => {
    expect(await hrefs(value)).toEqual(["/account/clubs/club-1"]);
  });
});
