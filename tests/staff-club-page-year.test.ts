import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The staff "Open club" page (#386) with a club-year choice (#541): the
 * import result links here, so staff can see an imported roster in the
 * previous, current, or next year. System administrators only, as before;
 * the "Move import to another year" panel shows only for a club with an import.
 */

const mocks = vi.hoisted(() => ({
  getCurrentSession: vi.fn(),
  orgFindUnique: vi.fn(),
  listClubImports: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ organization: { findUnique: mocks.orgFindUnique } }) }));
vi.mock("@/modules/club-imports/move-year", () => ({ listClubImports: mocks.listClubImports }));

import StaffOpenClubPage from "@/app/(workspace)/admin/organizations/[organizationId]/club/page";
import { ClubImportYearMove } from "@/components/club-import-year-move";
import { ClubOverview } from "@/components/club-overview";

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

const open = (year?: string) => StaffOpenClubPage({
  params: Promise.resolve({ organizationId: "club-1" }),
  searchParams: Promise.resolve(year === undefined ? {} : { year }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T15:00:00Z"));
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "admin-1", globalRole: "SYSTEM_ADMIN" } });
  mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", name: "Fixture Pathfinders", isActive: true, parentOrganization: null });
  mocks.listClubImports.mockResolvedValue([{ identityId: "identity-1", entryId: "90541", clubYear: "2025-26", peopleOnRoster: 48 }]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the staff club page's club year (#541)", () => {
  it("shows the chosen year's roster, read-only, with links to the three years", async () => {
    const tree = await open("2025-26");
    const all = elements(tree);
    expect(all.find((element) => element.type === ClubOverview)?.props).toMatchObject({ rosterYear: "2025-26" });
    const clubLinks = all.filter((element) => typeof element.props.href === "string" && String(element.props.href).startsWith("/admin/organizations/club-1/club"));
    // The staff Honors screen (#591) is its own link, not one of the year choices.
    expect(clubLinks.some((link) => link.props.href === "/admin/organizations/club-1/club/honors")).toBe(true);
    const links = clubLinks.filter((link) => link.props.href !== "/admin/organizations/club-1/club/honors");
    expect(links.map((link) => [link.props.href, link.props["aria-current"]])).toEqual([
      ["/admin/organizations/club-1/club?year=2025-26", "page"],
      ["/admin/organizations/club-1/club", undefined],
      ["/admin/organizations/club-1/club?year=2027-28", undefined],
    ]);
    const texts = all.flatMap((element) => [element.props.children].flat().filter((child): child is string => typeof child === "string"));
    expect(texts.some((text) => text.includes("roster, read-only"))).toBe(true);
  });

  it("falls back to the current year for an invalid year", async () => {
    const all = elements(await open("1999-00"));
    expect(all.find((element) => element.type === ClubOverview)?.props).toMatchObject({ rosterYear: "2026-27" });
  });

  it("offers the Move action for a club with an import, with the three year choices", async () => {
    const all = elements(await open());
    expect(all.find((element) => element.type === ClubImportYearMove)?.props).toEqual({
      imports: [{ identityId: "identity-1", entryId: "90541", clubYear: "2025-26", peopleOnRoster: 48 }],
      organizationId: "club-1",
      yearChoices: ["2025-26", "2026-27", "2027-28"],
    });
    mocks.listClubImports.mockResolvedValue([]);
    expect(elements(await open()).some((element) => element.type === ClubImportYearMove)).toBe(false);
  });

  it("keeps the page for system administrators only", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff-1", globalRole: "EVENT_STAFF" } });
    await expect(open("2025-26")).rejects.toThrow("REDIRECT /no-access");
    expect(mocks.listClubImports).not.toHaveBeenCalled();
  });
});
