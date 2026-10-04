import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  TeamAccountMenu,
  nextMenuIndex,
  teamMenuItems,
} from "@/components/team-account-menu";
import {
  TeamDirectoryWorkspace,
  breakableEmail,
} from "@/components/team-directory-workspace";

const member = (over: Record<string, unknown> = {}) => ({
  id: "u2",
  mfaStatus: "ACTIVE",
  signInDisabled: false,
  ...over,
});
const labels = (items: { label: string }[]) => items.map((item) => item.label);

describe("team account menu items", () => {
  it("offers every action for another member with two-step started", () => {
    const items = teamMenuItems(member(), "me");
    expect(labels(items)).toEqual([
      "Send password reset",
      "Change email",
      "Reset two-step",
      "Disable sign-in",
    ]);
    expect(items.find((item) => item.key === "toggle-sign-in")?.danger).toBe(true);
  });

  it("omits reset two-step when two-step is not set up", () => {
    expect(labels(teamMenuItems(member({ mfaStatus: "NONE" }), "me"))).not.toContain("Reset two-step");
  });

  it("offers Allow sign-in, not styled as danger, for a disabled account", () => {
    const toggle = teamMenuItems(member({ signInDisabled: true }), "me").at(-1);
    expect(toggle).toMatchObject({ label: "Allow sign-in", danger: false });
  });

  it("never offers reset two-step or the sign-in toggle for yourself", () => {
    expect(labels(teamMenuItems(member({ id: "me" }), "me"))).toEqual([
      "Send password reset",
      "Change email",
    ]);
  });
});

describe("team account menu rendering and keyboard", () => {
  it("renders a closed menu button with menu aria and no list", () => {
    const html = renderToStaticMarkup(createElement(TeamAccountMenu, {
      memberName: "Sample Person",
      items: teamMenuItems(member(), "me"),
      disabled: false,
      onSelect: () => {},
    }));
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="More actions for Sample Person"');
    expect(html).not.toContain('role="menu"');
  });

  it("moves focus with arrows, wrapping, and Home/End", () => {
    expect(nextMenuIndex("ArrowDown", 0, 4)).toBe(1);
    expect(nextMenuIndex("ArrowDown", 3, 4)).toBe(0);
    expect(nextMenuIndex("ArrowUp", 0, 4)).toBe(3);
    expect(nextMenuIndex("Home", 2, 4)).toBe(0);
    expect(nextMenuIndex("End", 0, 4)).toBe(3);
    expect(nextMenuIndex("a", 0, 4)).toBeNull();
  });
});

describe("team directory table", () => {
  it("breaks emails only after @ and dots", () => {
    const html = renderToStaticMarkup(createElement("p", null, breakableEmail("a.b@c.example")));
    expect(html.replace(/<\/?span>/g, "")).toBe("<p>a.<wbr/>b@<wbr/>c.<wbr/>example</p>");
  });

  it("uses short headers and keeps Edit profile visible with a More actions menu", () => {
    const html = renderToStaticMarkup(createElement(TeamDirectoryWorkspace, {
      currentUserId: "me",
      initialDirectory: {
        totalCount: 1,
        activeCount: 1,
        systemAdminCount: 0,
        withoutAccessCount: 0,
        members: [{
          id: "me",
          email: "me@example.test",
          displayName: "Sample Me",
          jobTitle: "",
          phone: "",
          bio: "",
          globalRole: "USER",
          accountStatus: "ACTIVE",
          signInDisabled: false,
          mfaStatus: "NONE",
          lastSignedInAt: null,
          memberships: [],
        }],
      } as never,
    }));
    for (const header of ["Sign-in", "Two-step", "Last sign-in"]) {
      expect(html).toContain(`>${header}</th>`);
    }
    expect(html).toContain("Edit profile");
    expect(html).toContain("More actions");
    expect(html).toContain("This is you");
    expect(html).not.toContain("Send password reset");
  });
});
