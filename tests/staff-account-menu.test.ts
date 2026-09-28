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
    settingsHref: "/more?event=event_1",
    systemAdminContext: contexts.find((context) => context.kind === "system_admin"),
  }));
}

describe("staff account menu (#543)", () => {
  it("shows name, email, Passkeys, Two-step verification and Sign out to event staff, without System management", () => {
    const markup = renderMenu({ isSystemAdmin: false });
    expect(markup).toContain("Riley Staff");
    expect(markup).toContain("riley@imsda-events.test");
    expect(markup).toContain('href="/more?event=event_1#passkeys"');
    expect(markup).toContain("Passkeys");
    expect(markup).toContain('href="/more?event=event_1#two-step-verification"');
    expect(markup).toContain("Two-step verification");
    expect(markup).toContain("Sign out");
    expect(markup).not.toContain("System management");
    expect(markup).not.toContain("Switch to my attendee account");
  });

  it("adds System management for administrators and the attendee switch only when available", () => {
    const admin = renderMenu({ isSystemAdmin: true });
    expect(admin).toContain('href="/admin"');
    expect(admin).toContain("System management");
    expect(admin).toContain("#passkeys");
    expect(admin).toContain("Sign out");
    expect(renderMenu({ isSystemAdmin: false, attendeeAccountAvailable: true })).toContain("Switch to my attendee account");
  });

  it("is a closed, labelled disclosure until opened", () => {
    const closed = renderMenu({ isSystemAdmin: true, defaultOpen: false });
    expect(closed).toContain('aria-label="Staff account"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("Passkeys");
    expect(renderMenu({ isSystemAdmin: true })).toContain('aria-expanded="true"');
  });

  it("wires the shell to the account menu and keeps the menu closed on first render", () => {
    const markup = renderToStaticMarkup(createElement(AppShell as never, {
      events: [{ id: "event_1", slug: "retreat", name: "Retreat", permissions: [] }],
      user: { displayName: "Casey Admin", email: "casey@imsda-events.test", globalRole: "SYSTEM_ADMIN" },
    }, createElement("p", null, "content")));
    expect(markup).toContain('aria-label="Staff account"');
    expect(markup).not.toContain("Two-step verification");
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

  it("uses only the label 'Clubs and churches' in app, components and modules", () => {
    const offenders: string[] = [];
    for (const dir of ["app", "components", "modules"]) {
      for (const file of walk(join(process.cwd(), dir))) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(/churches\s+and\s+clubs|clubs\s+and\s+churches/gi)) {
          if (match[0] !== "Clubs and churches") offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
