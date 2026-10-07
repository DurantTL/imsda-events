import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #722: the coordinator club layout is only chrome, but it still answers 404
 * to anyone who is not an active Area Coordinator viewer. The viewer check is
 * the real one; only its inputs (the attendee session, the staff act-as, the
 * database) are faked. Synthetic ids only.
 */
const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  currentStaffActingContext: vi.fn(),
  accountNeedsSecondStep: vi.fn(),
  grantFindUnique: vi.fn(),
  orgFindUnique: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn(), usePathname: () => "/account/area/club-1/honors" }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    areaCoordinatorGrant: { findUnique: mocks.grantFindUnique },
    organization: { findUnique: mocks.orgFindUnique },
  }),
}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: mocks.accountNeedsSecondStep }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));

import AreaClubLayout from "@/app/(public)/account/(portal)/area/[organizationId]/layout";
import { AccountSectionNav } from "@/components/account-section-nav";
import { areaClubPortalNavItems } from "@/modules/club-rosters/portal-nav";

const props = { children: null, params: Promise.resolve({ organizationId: "club-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
  mocks.currentStaffActingContext.mockResolvedValue(null);
  mocks.accountNeedsSecondStep.mockResolvedValue("OK");
  mocks.grantFindUnique.mockResolvedValue(null);
  mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", name: "Synthetic Trail Club", isActive: true, parentOrganization: null });
});

describe("area club layout access (#722)", () => {
  it("is a 404 for someone who is not a coordinator", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "acct-1" }, via: "attendee", sessionId: "sess-1" });
    await expect(AreaClubLayout(props)).rejects.toThrow("NOT_FOUND");
    expect(mocks.orgFindUnique).not.toHaveBeenCalled();
  });

  it("is a 404 for a staff act-as with a different role", async () => {
    mocks.currentStaffActingContext.mockResolvedValue({ role: "CLUB_DIRECTOR", organizationId: "club-1" });
    await expect(AreaClubLayout(props)).rejects.toThrow("NOT_FOUND");
    expect(mocks.orgFindUnique).not.toHaveBeenCalled();
  });

  it("is a 404 for an inactive club or a non-club even for a coordinator", async () => {
    mocks.currentStaffActingContext.mockResolvedValue({ role: "AREA_COORDINATOR", organizationId: null });
    mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", name: "Synthetic Trail Club", isActive: false, parentOrganization: null });
    await expect(AreaClubLayout(props)).rejects.toThrow("NOT_FOUND");
    mocks.orgFindUnique.mockResolvedValue({ type: "CHURCH", name: "Synthetic Church", isActive: true, parentOrganization: null });
    await expect(AreaClubLayout(props)).rejects.toThrow("NOT_FOUND");
  });

  it("renders for a real coordinator and for an act-as coordinator", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "acct-1" }, via: "attendee", sessionId: "sess-1" });
    mocks.grantFindUnique.mockResolvedValue({ revokedAt: null, expiresAt: null });
    expect(await AreaClubLayout(props)).toBeTruthy();
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    mocks.currentStaffActingContext.mockResolvedValue({ role: "AREA_COORDINATOR", organizationId: null });
    expect(await AreaClubLayout(props)).toBeTruthy();
  });
});

describe("area club menu markup (#722)", () => {
  const html = renderToStaticMarkup(
    createElement(AccountSectionNav, { items: areaClubPortalNavItems({ organizationId: "club-1" }), label: "Club", variant: "secondary" }) as ReactElement,
  );

  it("renders each item once, all inside the club, with the current page marked", () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    expect(hrefs).toEqual([
      "/account/area/club-1",
      "/account/area/club-1#open-club-roster",
      "/account/area/club-1/honors",
      "/account/area/club-1#open-club-events",
      "/account/area/club-1/forms",
      "/account/area/club-1#open-club-reports",
      "/account/area/club-1/orders",
      "/account/area/club-1/awards",
    ]);
    expect(html).toContain('aria-current="page" href="/account/area/club-1/honors"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain("account-nav-secondary");
    expect(html).not.toContain("Sterling Volunteers");
  });
});
