import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const navState = vi.hoisted(() => ({ pathname: "/overview" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navState.pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams("event=event_1"),
}));

vi.mock("@/components/sign-out-button", () => ({
  SignOutButton: () => createElement("button", { type: "button" }, "Sign out"),
}));

import { AppShell } from "@/components/app-shell";
import { mobileActiveTabHref } from "@/components/staff-navigation";

/** The More launcher in the rendered shell, and the phone tab for More-only pages (#737). Synthetic data only. */

const AppShellElement = AppShell as ComponentType<Omit<Parameters<typeof AppShell>[0], "children">>;

function render(clubEvent: boolean, permissions: readonly ("MANAGE_CHECK_IN" | "VIEW_HEALTH_INFORMATION" | "VIEW_EVENT")[], pathname = "/overview") {
  navState.pathname = pathname;
  return renderToStaticMarkup(
    createElement(
      AppShellElement,
      {
        events: [{ id: "event_1", slug: "club-camporee", name: "Club Camporee", permissions, clubEvent }],
        user: { displayName: "Charlie Check-in", email: "checkin@imsda-events.test" },
      },
      createElement("p", null, "Workspace content"),
    ),
  );
}

const mobileNav = (markup: string) => markup.slice(markup.indexOf('aria-label="Mobile navigation"'));
const sidebar = (markup: string) => markup.slice(markup.indexOf('aria-label="Primary navigation"'), markup.indexOf('aria-label="Mobile navigation"'));

describe("More launcher in the shell (#737)", () => {
  const checkInPlusHealth = ["MANAGE_CHECK_IN", "VIEW_HEALTH_INFORMATION"] as const;

  it("shows More on desktop and phone for check-in plus health on a club event", () => {
    const markup = render(true, checkInPlusHealth);
    expect(sidebar(markup)).toContain("/more?event=event_1");
    expect(mobileNav(markup)).toContain("/more?event=event_1");
  });

  it("hides More on a general event, where the health page does not apply", () => {
    const markup = render(false, checkInPlusHealth);
    expect(sidebar(markup)).not.toContain("/more?event=event_1");
    expect(mobileNav(markup)).not.toContain("/more?event=event_1");
  });

  it("hides More for check-in staff without health information", () => {
    const markup = render(true, ["MANAGE_CHECK_IN"]);
    expect(mobileNav(markup)).not.toContain("/more?event=event_1");
  });

  it("lights More, not Home, on /community", () => {
    const markup = render(true, checkInPlusHealth, "/community");
    expect(mobileNav(markup)).toMatch(/class="active"[^>]*href="\/more\?event=event_1"|href="\/more\?event=event_1"[^>]*aria-current="page"/);
    expect(mobileNav(markup)).not.toMatch(/href="\/overview[^"]*"[^>]*aria-current="page"/);
  });
});

describe("mobileActiveTabHref for More-only pages (#737)", () => {
  it("maps /community and below to More", () => {
    expect(mobileActiveTabHref("/overview", "/community")).toBe("/more");
    expect(mobileActiveTabHref("/overview", "/community/reports")).toBe("/more");
    expect(mobileActiveTabHref("/overview", "/communications")).toBe("/overview");
  });
});
