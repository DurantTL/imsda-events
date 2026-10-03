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
import { MoreLauncherPanel } from "@/components/more-launcher";
import {
  isPlainClick,
  launcherFooterLinks,
  launcherGroups,
  moduleRequestsEnabled,
  nextLauncherIndex,
  returnsFocusToTrigger,
} from "@/components/more-launcher-model";
import { buildMoreDirectoryCards, moreDirectoryGroupOrder, type MoreDirectoryContext } from "@/components/staff-navigation";
import { eventPermissions, type EventPermission } from "@/modules/access/permissions";
import { disabledModuleCardKeys, eventModuleCatalog, eventModuleKeys, moduleForCard, type EventModuleKey } from "@/modules/event-modules/catalog";

/** The More launcher (#741 slice 2): grouping, role limits, footers, keyboard and focus rules. Synthetic data only. */

const allPermissions: readonly EventPermission[] = eventPermissions;

function cardsFor(overrides: Partial<MoreDirectoryContext> & { enabled?: readonly EventModuleKey[] } = {}) {
  const { enabled = eventModuleKeys, ...context } = overrides;
  return buildMoreDirectoryCards({
    permissions: allPermissions,
    clubOversight: true,
    clubEvent: true,
    isSystemAdmin: false,
    clubFormsAccess: true,
    eventQuery: "?event=event_1",
    hiddenCardKeys: disabledModuleCardKeys(new Set(enabled)),
    ...context,
  });
}
const keysOf = (cards: ReturnType<typeof cardsFor>) => launcherGroups(cards).flatMap((group) => group.cards.map((card) => card.key));

describe("launcher grouping", () => {
  it("lists Setup, Content & sales, People & access, Reports in that order, with allowed cards only", () => {
    const groups = launcherGroups(cardsFor({ isSystemAdmin: true }));
    expect(groups.map((group) => group.label)).toEqual(["Setup", "Content & sales", "People & access", "Reports"]);
    expect(groups.map((group) => group.group)).toEqual(moreDirectoryGroupOrder);
    expect(groups.flatMap((group) => group.cards).every((card) => card.allowed)).toBe(true);
  });

  it("leaves out the groups with nothing the viewer may open (finance staff: no Setup, no People & access)", () => {
    const groups = launcherGroups(cardsFor({ permissions: ["MANAGE_FINANCE"], clubOversight: false, clubEvent: false, clubFormsAccess: false }));
    expect(groups.map((group) => group.group)).toEqual(["content-sales", "reports"]);
    expect(keysOf(cardsFor({ permissions: ["MANAGE_FINANCE"], clubOversight: false, clubEvent: false, clubFormsAccess: false }))).toEqual(["payments", "promo-codes", "health"]);
  });

  it("is empty for staff whose only permission opens no More destination", () => {
    expect(launcherGroups(cardsFor({ permissions: ["MANAGE_CHECK_IN"], clubOversight: false, clubEvent: false, clubFormsAccess: false }))).toEqual([]);
  });

  it("lists a module's card only while the module is on", () => {
    const withAll = keysOf(cardsFor());
    const withoutMerch = keysOf(cardsFor({ enabled: eventModuleKeys.filter((key) => key !== "merchandise") }));
    expect(withAll).toContain("merchandise");
    expect(withoutMerch).not.toContain("merchandise");
    expect(withoutMerch).toEqual(withAll.filter((key) => key !== "merchandise"));
  });

  it("never lists a disabled module, even for a system administrator (the Event modules page lists those)", () => {
    const keys = keysOf(cardsFor({ isSystemAdmin: true, enabled: ["public-content"] }));
    for (const definition of eventModuleCatalog.filter((entry) => !entry.alwaysOn)) expect(keys).not.toContain(definition.cardKey);
    expect(keys).toContain("event-content");
  });

  it("does not let a module being on grant a card the role cannot open", () => {
    const keys = keysOf(cardsFor({ permissions: ["VIEW_EVENT"], clubOversight: false, clubFormsAccess: false }));
    expect(keys).toEqual([]);
  });
});

describe("phone More keeps every universal tool", () => {
  const universal = ["event-settings", "attendee-configuration", "tags", "registration-builder", "payments", "promo-codes", "staff", "imports", "reports", "health", "club-forms"];

  it("lists each existing universal tool alongside the enabled modules, with every module off", () => {
    const keys = keysOf(cardsFor({ enabled: ["public-content"], isSystemAdmin: true }));
    for (const key of universal) expect(keys).toContain(key);
  });

  it("matches the allowed cards one for one, so the launcher and the directory cannot drift", () => {
    const cards = cardsFor();
    expect(keysOf(cards).sort()).toEqual(cards.filter((card) => card.allowed).map((card) => card.key).sort());
  });

  it("treats no universal tool as a module", () => {
    for (const key of universal) expect(moduleForCard(key)).toBeUndefined();
  });
});

describe("Club forms stay reachable", () => {
  it("is offered to system admins and Event Admins on a general event with every module off, and never to anyone else", () => {
    const base = { enabled: ["public-content"] as const, clubOversight: false, clubEvent: false };
    expect(keysOf(cardsFor({ ...base, isSystemAdmin: true, clubFormsAccess: true }))).toContain("club-forms");
    expect(keysOf(cardsFor({ ...base, clubFormsAccess: true }))).toContain("club-forms");
    expect(keysOf(cardsFor({ ...base, clubFormsAccess: false }))).not.toContain("club-forms");
  });
});

describe("launcher footer", () => {
  it("offers a system administrator Manage event modules, linking to /more for the event", () => {
    expect(launcherFooterLinks({ isSystemAdmin: true, eventQuery: "?event=event_1" })).toEqual([
      { key: "manage-modules", label: "Manage event modules", href: "/more?event=event_1" },
    ]);
  });

  it("offers event staff Event modules and activity, a plain link to /more, and no Request a feature while requests do not exist", () => {
    expect(moduleRequestsEnabled).toBe(false);
    expect(launcherFooterLinks({ isSystemAdmin: false, canRequestFeature: true, eventQuery: "?event=event_1" })).toEqual([
      { key: "event-modules", label: "Event modules and activity", href: "/more?event=event_1" },
    ]);
  });

  it("is ready to offer Request a feature, only where permitted, once the flag is on", () => {
    expect(launcherFooterLinks({ isSystemAdmin: false, canRequestFeature: true, requestsEnabled: true, eventQuery: "?event=event_1" }).map((link) => link.label)).toEqual(["Event modules and activity", "Request a feature"]);
    expect(launcherFooterLinks({ isSystemAdmin: false, canRequestFeature: false, requestsEnabled: true, eventQuery: "?event=event_1" }).map((link) => link.label)).toEqual(["Event modules and activity"]);
  });
});

describe("keyboard and focus rules", () => {
  it("moves with the arrow keys in reading order and wraps at both ends", () => {
    expect(nextLauncherIndex(0, 5, "ArrowDown")).toBe(1);
    expect(nextLauncherIndex(4, 5, "ArrowDown")).toBe(0);
    expect(nextLauncherIndex(0, 5, "ArrowUp")).toBe(4);
    expect(nextLauncherIndex(3, 5, "ArrowUp")).toBe(2);
    expect(nextLauncherIndex(-1, 5, "ArrowDown")).toBe(0);
    expect(nextLauncherIndex(2, 5, "Home")).toBe(0);
    expect(nextLauncherIndex(2, 5, "End")).toBe(4);
  });

  it("ignores other keys and an empty list", () => {
    expect(nextLauncherIndex(1, 5, "a")).toBeNull();
    expect(nextLauncherIndex(0, 0, "ArrowDown")).toBeNull();
  });

  it("returns focus to the trigger on Escape and on the trigger itself, but not after an outside click or navigation", () => {
    expect(returnsFocusToTrigger("escape")).toBe(true);
    expect(returnsFocusToTrigger("toggle")).toBe(true);
    expect(returnsFocusToTrigger("outside")).toBe(false);
    expect(returnsFocusToTrigger("navigate")).toBe(false);
  });

  it("opens only on a plain left click, so a modified click still opens the link", () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isPlainClick(click)).toBe(true);
    expect(isPlainClick({ ...click, metaKey: true })).toBe(false);
    expect(isPlainClick({ ...click, ctrlKey: true })).toBe(false);
    expect(isPlainClick({ ...click, button: 1 })).toBe(false);
  });
});

describe("launcher panel markup", () => {
  const render = (isSystemAdmin: boolean, variant: "sidebar" | "tab" = "sidebar") => renderToStaticMarkup(
    createElement(MoreLauncherPanel, { cards: cardsFor({ isSystemAdmin }), isSystemAdmin, eventQuery: "?event=event_1", variant }),
  );

  it("is a labelled dialog with a link per card, grouped in order", () => {
    const markup = render(true);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="More tools"');
    const positions = ["Setup", "Content &amp; sales", "People &amp; access", "Reports"].map((label) => markup.indexOf(`>${label}</h2>`));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(markup).toContain('href="/more/event-settings?event=event_1"');
    expect(markup).toContain('href="/more/club-forms?event=event_1"');
  });

  it("shows Manage event modules to a system administrator only, and never Request a feature", () => {
    expect(render(true)).toContain('data-footer="manage-modules"');
    expect(render(true)).toContain(">Manage event modules<");
    expect(render(false)).not.toContain("Manage event modules");
    expect(render(false)).toContain(">Event modules and activity<");
    expect(render(false)).toContain('href="/more?event=event_1"');
    expect(render(false)).not.toContain("Request a feature");
    expect(render(true)).not.toContain("Request a feature");
  });

  it("makes the phone sheet modal and the desktop popover non-modal", () => {
    expect(render(false, "tab")).toContain('aria-modal="true"');
    expect(render(false, "sidebar")).not.toContain("aria-modal");
  });

  it("uses the sheet class on a phone and the popover class on desktop", () => {
    expect(render(false, "tab")).toContain("more-launcher-tab");
    expect(render(false, "sidebar")).toContain("more-launcher-sidebar");
  });
});

describe("launcher in the shell", () => {
  const AppShellElement = AppShell as ComponentType<Omit<Parameters<typeof AppShell>[0], "children">>;
  const shell = (extra: Record<string, unknown> = {}, user: { globalRole?: "SYSTEM_ADMIN" | null } = {}) => renderToStaticMarkup(
    createElement(
      AppShellElement,
      {
        events: [{ id: "event_1", slug: "club-camporee", name: "Club Camporee", permissions: allPermissions, clubEvent: true, clubOversight: true, ...extra }],
        user: { displayName: "Riley Event Admin", email: "riley@imsda-events.test", ...user },
      },
      createElement("p", null, "Workspace content"),
    ),
  );

  it("keeps More last in the sidebar and the phone tabs, as a link that opens the launcher", () => {
    const markup = shell();
    const nav = markup.slice(markup.indexOf('aria-label="Primary navigation"'), markup.indexOf('class="sidebar-foot"'));
    expect(nav.lastIndexOf("/more?event=event_1")).toBeGreaterThan(nav.lastIndexOf("/communications?event=event_1"));
    expect(nav).toContain('aria-haspopup="dialog"');
    expect(nav).toContain('aria-expanded="false"');
    const tabs = markup.slice(markup.indexOf('aria-label="Mobile navigation"'));
    expect(tabs.match(/<a /g)).toHaveLength(5);
    expect(tabs.lastIndexOf("/more?event=event_1")).toBeGreaterThan(tabs.lastIndexOf("/communications?event=event_1"));
    expect(tabs).toContain('aria-haspopup="dialog"');
  });

  it("renders the launcher closed, and keeps the sidebar collapse button", () => {
    const markup = shell();
    expect(markup).not.toContain('role="dialog"');
    expect(markup).toContain("sidebar-toggle");
    expect(markup).toContain("Collapse sidebar");
  });

  it("no longer pins the club directory in the sidebar", () => {
    expect(shell()).not.toContain("nav-group-label\">Clubs and churches");
  });
});
