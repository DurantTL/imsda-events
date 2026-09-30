import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/** #543, #646: the attendee portal has one Profile tab, pointing at the portal-hosted /account/profile. */
const mocks = vi.hoisted(() => ({
  navItems: [] as Array<{ href: string; label: string }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT ${path}`);
  },
}));
vi.mock("@/components/account-section-nav", () => ({
  AccountSectionNav: (props: { items: Array<{ href: string; label: string }> }) => {
    mocks.navItems = props.items;
    return createElement("nav", null, props.items.map((item) => item.label).join("|"));
  },
}));
vi.mock("@/components/act-as-banner", () => ({ ActAsBanner: () => null }));
vi.mock("@/modules/communications/account-banner", () => ({ listAccountBannerAnnouncements: async () => [] }));
vi.mock("@/components/attendee-sign-in-form", () => ({ AttendeeAuthReturn: () => null }));
vi.mock("@/components/attendee-sign-out-button", () => ({ AttendeeSignOutButton: () => null }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: async () => ({ user: null }) }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  getCurrentAttendee: async () => ({
    account: { id: "att-1", verifiedEmail: "pat@imsda-events.test", displayName: "Pat Attendee" },
    via: "attendee",
    sessionId: "a1",
  }),
}));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: async () => "OK" }));
vi.mock("@/modules/organizations/area-coordinators", () => ({ isAreaCoordinator: async () => false }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: async () => [] }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: async () => null }));

import AccountPortalLayout from "@/app/(public)/account/(portal)/layout";

describe("attendee portal navigation (#543)", () => {
  it("has a single Profile entry pointing at /account/profile, and no Security tab", async () => {
    renderToStaticMarkup(await AccountPortalLayout({ children: null }));
    const labels = mocks.navItems.map((item) => item.label);
    expect(labels.filter((label) => label === "Profile")).toHaveLength(1);
    expect(mocks.navItems.find((item) => item.label === "Profile")?.href).toBe("/account/profile");
    expect(labels).not.toContain("Security");
    expect(mocks.navItems.some((item) => item.href.startsWith("/account/security"))).toBe(false);
  });
});
