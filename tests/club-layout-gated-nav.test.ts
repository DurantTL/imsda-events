import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRosterAccessStateForPage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
  usePathname: () => "/account/clubs/club-1/records",
}));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));
vi.mock("@/modules/attendee-accounts/portal-second-step", () => ({ requireAttendeeSecondStep: vi.fn() }));
vi.mock("@/modules/attendee-accounts/return-redirect", () => ({ attendeeSignInRedirectPath: vi.fn() }));

import ClubLayout from "@/app/(public)/account/(portal)/clubs/[organizationId]/layout";
import { AccountSectionNav, type AccountNavItem } from "@/components/account-section-nav";

type AnyProps = Record<string, unknown>;

function navs(node: ReactNode, found: ReactElement<AnyProps>[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) navs(child, found);
    return found;
  }
  if (!isValidElement<AnyProps>(node)) return found;
  if (node.type === AccountSectionNav) found.push(node);
  navs(node.props.children as ReactNode, found);
  return found;
}

const club = (role: string) => ({ organizationId: "club-1", name: "Fixture Pathfinders", role, sponsoringChurch: null });

async function navLabels(access: unknown) {
  mocks.getRosterAccessStateForPage.mockResolvedValue(access);
  const tree = await ClubLayout({ children: null, params: Promise.resolve({ organizationId: "club-1" }) });
  return navs(tree).map((nav) => (nav.props.items as AccountNavItem[]).map((item) => item.label));
}

beforeEach(() => vi.clearAllMocks());

describe("the club layout while the roster gate is up (#687)", () => {
  it.each([
    ["MFA_SETUP", { state: "MFA_SETUP", club: club("DIRECTOR") }],
    ["MFA_UNLOCK", { state: "MFA_UNLOCK", club: club("DIRECTOR"), methods: { code: true, passkey: false } }],
  ])("keeps Home and Monthly Records in the nav in %s for someone who can submit reports", async (_name, access) => {
    expect(await navLabels(access)).toEqual([["Home", "Monthly Records"]]);
  });

  it("shows no nav in the gate when the role can't submit reports", async () => {
    expect(await navLabels({ state: "MFA_SETUP", club: club("REGISTRAR") })).toEqual([]);
  });
});
