import { readFileSync } from "node:fs";
import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/overview",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams("event=event_1"),
}));

vi.mock("@/components/sign-out-button", () => ({
  SignOutButton: () => createElement("button", { type: "button" }, "Sign out"),
}));

import { AppShell } from "@/components/app-shell";
import { readSidebarCollapsed, sidebarCollapsedStorageKey, writeSidebarCollapsed } from "@/components/sidebar-collapse";
import { matchesVisibility, navigation } from "@/components/staff-navigation";
import { rolePermissions } from "@/modules/access/permissions";

/** Collapsible staff sidebar (#446). Synthetic data only. */

const AppShellElement = AppShell as ComponentType<Omit<Parameters<typeof AppShell>[0], "children">>;

function render(permissions: readonly (keyof typeof rolePermissions | string)[] | readonly string[]) {
  return renderToStaticMarkup(
    createElement(
      AppShellElement,
      {
        events: [{ id: "event_1", slug: "demo", name: "Demo Event", permissions: permissions as never }],
        user: { displayName: "Sam Staff", email: "staff@imsda-events.test" },
      },
      createElement("p", null, "Workspace content"),
    ),
  );
}

const sidebar = (markup: string) => markup.slice(markup.indexOf('aria-label="Primary navigation"'), markup.indexOf('aria-label="Mobile navigation"'));

describe("sidebar collapse toggle", () => {
  it("renders expanded on the server with an accessible, labelled toggle", () => {
    const markup = render(rolePermissions.EVENT_ADMIN);
    expect(markup).toContain('data-sidebar="expanded"');
    expect(markup).toMatch(/<button[^>]*class="sidebar-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="primary-navigation"|<button[^>]*aria-expanded="true"[^>]*class="sidebar-toggle"/);
    expect(markup).toContain("Collapse sidebar");
    expect(markup).toContain('id="primary-navigation"');
  });

  it("keeps a text label in every nav link, so collapsing cannot remove its name", () => {
    const links = [...sidebar(render(rolePermissions.EVENT_ADMIN)).matchAll(/<a class="nav-item[^"]*"[^>]*>(.*?)<\/a>/g)];
    expect(links.length).toBeGreaterThan(3);
    for (const [, inner] of links) expect(inner.replace(/<svg.*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim()).not.toBe("");
  });

  it("shows the same links as before for each role: visibility is unchanged", () => {
    for (const role of ["EVENT_ADMIN", "CHECK_IN_STAFF", "READ_ONLY_STAFF"] as const) {
      const permissions = new Set<string>(rolePermissions[role]);
      const markup = sidebar(render(rolePermissions[role]));
      for (const item of navigation) {
        const visible = matchesVisibility(item, permissions as never);
        if (item.href === "/more") continue;
        expect(markup.includes(`href="${item.href}?event=event_1"`), `${role} ${item.href}`).toBe(visible);
      }
    }
  });
});

describe("sidebar collapse storage", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
  };

  it("round-trips the choice", () => {
    const storage = memory();
    expect(readSidebarCollapsed(storage)).toBe(false);
    writeSidebarCollapsed(true, storage);
    expect(storage.getItem(sidebarCollapsedStorageKey)).toBe("1");
    expect(readSidebarCollapsed(storage)).toBe(true);
    writeSidebarCollapsed(false, storage);
    expect(readSidebarCollapsed(storage)).toBe(false);
  });

  it("falls back to expanded and never throws when storage fails", () => {
    const broken = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(readSidebarCollapsed(broken)).toBe(false);
    expect(() => writeSidebarCollapsed(true, broken)).not.toThrow();
    // No window in this environment: the default storage lookup also fails safe.
    expect(readSidebarCollapsed()).toBe(false);
  });
});

describe("sidebar collapse CSS", () => {
  const css = readFileSync("app/globals.css", "utf8");

  it("only narrows the sidebar on desktop widths and hides the tooltip in print", () => {
    expect(css).toMatch(/@media \(min-width: 801px\) \{\s*\.app-shell\[data-sidebar="collapsed"\] \{ --sidebar-width: 76px; \}/);
    expect(css).toContain("@media print { .sidebar-tooltip { display: none !important; } }");
  });

  it("clips link text instead of removing it", () => {
    expect(css).toMatch(/\.nav-item > span,[\s\S]*?clip-path: inset\(50%\)/);
  });
});
