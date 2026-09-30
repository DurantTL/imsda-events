// @vitest-environment node
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  accountNeedsSecondStep: vi.fn(),
  grantFindUnique: vi.fn(),
  currentStaffActingContext: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ areaCoordinatorGrant: { findUnique: mocks.grantFindUnique } }) }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: mocks.accountNeedsSecondStep }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: mocks.currentStaffActingContext }));
vi.mock("@/modules/attendee-accounts/portal-second-step", () => ({ requireAttendeeSecondStep: vi.fn() }));
vi.mock("@/modules/attendee-accounts/mfa-service", () => ({ getAttendeeMfaStatus: vi.fn(async () => ({ status: "NONE" })) }));
vi.mock("@/modules/attendee-accounts/registrations-repository", () => ({ listRegistrationsForVerifiedEmail: vi.fn(async () => []) }));
vi.mock("@/modules/club-imports/invites", () => ({ listInvitesForAccount: vi.fn(async () => []) }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: vi.fn(async () => []) }));
vi.mock("@/components/club-invite-accept", () => ({ ClubInviteAccept: () => null }));
vi.mock("@/components/area-coordinator-card", () => ({
  AreaCoordinatorCardSection: function AreaCoordinatorCardSection() { return null; },
  AreaCoordinatorCardSkeleton: function AreaCoordinatorCardSkeleton() { return null; },
}));

import { AreaCoordinatorCardSection } from "@/components/area-coordinator-card";
import AttendeeAccountOverviewPage from "@/app/(public)/account/(portal)/page";

function findElement(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return findElement((node.props as { children?: ReactNode }).children, type);
}

const account = { id: "acct-1", displayName: "Synthetic Coordinator", verifiedEmail: "coordinator@example.test" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.accountNeedsSecondStep.mockResolvedValue("OK");
  mocks.currentStaffActingContext.mockResolvedValue(null);
});

describe("portal home Area coordinator card", () => {
  it("is present for an active coordinator's own session, given their account", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "s1" });
    mocks.grantFindUnique.mockResolvedValue({ revokedAt: null, expiresAt: null });
    const card = findElement(await AttendeeAccountOverviewPage(), AreaCoordinatorCardSection);
    expect(card?.props).toEqual({ account: expect.objectContaining({ id: "acct-1" }) });
  });

  it("is absent when staff view the account, even one with an active grant", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account, via: "staff", sessionId: null });
    mocks.grantFindUnique.mockResolvedValue({ revokedAt: null, expiresAt: null });
    expect(findElement(await AttendeeAccountOverviewPage(), AreaCoordinatorCardSection)).toBeNull();
  });

  it.each([
    ["revoked", { revokedAt: new Date("2026-01-01T00:00:00Z"), expiresAt: null }],
    ["expired", { revokedAt: null, expiresAt: new Date("2026-01-01T00:00:00Z") }],
    ["never granted", null],
  ])("is absent for a %s grant", async (_label, grant) => {
    mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "s1" });
    mocks.grantFindUnique.mockResolvedValue(grant);
    expect(findElement(await AttendeeAccountOverviewPage(), AreaCoordinatorCardSection)).toBeNull();
  });
});
