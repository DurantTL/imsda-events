import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  usePathname: () => "/overview",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("event=event_1"),
}));

vi.mock("@/components/sign-out-button", () => ({
  SignOutButton: () => createElement("button", { type: "button" }, "Sign out"),
}));

import { StaffAccountMenu } from "@/components/staff-account-menu";
import { AppShell } from "@/components/app-shell";
import { otherWorkspaceContextsForStaff } from "@/modules/access/workspace-contexts";

function renderMenu(input: { isSystemAdmin: boolean; attendeeAccountAvailable?: boolean; defaultOpen?: boolean }) {
  const contexts = otherWorkspaceContextsForStaff({
    isSystemAdmin: input.isSystemAdmin,
    attendeeAccountAvailable: input.attendeeAccountAvailable ?? false,
  });
  return renderToStaticMarkup(createElement(StaffAccountMenu, {
    attendeePreviewHref: "/account",
    canSwitchToAttendee: contexts.some((context) => context.kind === "attendee"),
    defaultOpen: input.defaultOpen ?? true,
    displayName: "Riley Staff",
    email: "riley@imsda-events.test",
    systemAdminContext: contexts.find((context) => context.kind === "system_admin"),
  }));
}

describe("staff account menu (#543)", () => {
  it("shows name, email, Edit profile and Sign out to event staff, without System management or separate security links", () => {
    const markup = renderMenu({ isSystemAdmin: false });
    expect(markup).toContain("Riley Staff");
    expect(markup).toContain("riley@imsda-events.test");
    expect(markup).toContain('href="/profile"');
    expect(markup).toContain("Edit profile");
    expect(markup).toContain("Sign out");
    expect(markup).not.toContain("System management");
    expect(markup).not.toContain("Switch to my attendee account");
    expect(markup).not.toContain("Passkeys");
    expect(markup).not.toContain("Two-step");
  });

  it("adds System management for administrators and the attendee switch only when available", () => {
    const admin = renderMenu({ isSystemAdmin: true });
    expect(admin).toContain('href="/admin"');
    expect(admin).toContain("System management");
    expect(admin).toContain('href="/profile"');
    expect(admin).toContain("Edit profile");
    expect(admin).toContain("Sign out");
    expect(renderMenu({ isSystemAdmin: false, attendeeAccountAvailable: true })).toContain("Switch to my attendee account");
  });

  it("is a closed disclosure until opened, without a menu role or aria-haspopup", () => {
    const closed = renderMenu({ isSystemAdmin: true, defaultOpen: false });
    expect(closed).toContain('aria-label="Staff account"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('aria-controls="staff-account-menu"');
    expect(closed).not.toContain("aria-haspopup");
    expect(closed).not.toContain("Edit profile");
    const open = renderMenu({ isSystemAdmin: true });
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain("aria-haspopup");
    expect(open).not.toContain('role="menu"');
  });

  it("wires the shell to the account menu and keeps the menu closed on first render", () => {
    const markup = renderToStaticMarkup(createElement(AppShell as never, {
      events: [{ id: "event_1", slug: "retreat", name: "Retreat", permissions: [] }],
      user: { displayName: "Casey Admin", email: "casey@imsda-events.test", globalRole: "SYSTEM_ADMIN" },
    }, createElement("p", null, "content")));
    expect(markup).toContain('aria-label="Staff account"');
    expect(markup).not.toContain("Edit profile");
  });

  it("has the same menu with no event selected", () => {
    const markup = renderToStaticMarkup(createElement(AppShell as never, {
      events: [],
      user: { displayName: "Casey Admin", email: "casey@imsda-events.test", globalRole: "SYSTEM_ADMIN" },
    }, createElement("p", null, "content")));
    expect(markup).toContain('aria-label="Staff account"');
  });
});

describe("Clubs and churches naming (#543)", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (/\.(ts|tsx|md)$/.test(name)) out.push(path);
    }
    return out;
  }

  it("has no reversed or title-cased variants of 'Clubs and churches' in app, components and modules", () => {
    const offenders: string[] = [];
    for (const dir of ["app", "components", "modules"]) {
      for (const file of walk(join(process.cwd(), dir))) {
        const text = readFileSync(file, "utf8");
        // Reversed order in any case, or title-cased "Churches"; lowercase
        // "clubs and churches" in running text is fine.
        for (const match of text.matchAll(/churches(?:\s+and\s+|\s*&(?:amp;)?\s*)clubs|clubs(?:\s+and\s+|\s*&(?:amp;)?\s*)churches/gi)) {
          if (/^churches/i.test(match[0]) || match[0] !== match[0].replace(/Churches/, "churches")) {
            offenders.push(`${file}: ${match[0]}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
