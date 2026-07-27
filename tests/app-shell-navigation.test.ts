import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/overview",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("event=event_1"),
}));

vi.mock("@/components/sign-out-button", () => ({
  SignOutButton: () => createElement("button", { type: "button" }, "Sign out"),
}));

import { AppShell } from "@/components/app-shell";

const AppShellElement = AppShell as ComponentType<
  Omit<Parameters<typeof AppShell>[0], "children">
>;

const events = [{
  id: "event_1",
  name: "Women’s Retreat 2026",
  permissions: [
    "VIEW_SENSITIVE_DATA",
    "MANAGE_FINANCE",
  ] as const,
}];

describe("application shell navigation", () => {
  it("places global system management before the event workspace", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AppShellElement,
        {
          events,
          user: {
            displayName: "Casey System Admin",
            email: "system@imsda-events.test",
            globalRole: "SYSTEM_ADMIN",
          },
        },
        createElement("p", null, "Workspace content"),
      ),
    );

    expect(markup).toContain("Global administration");
    expect(markup).toContain("System management");
    expect(markup).toContain("Event workspace");
    expect(markup.indexOf("System management")).toBeLessThan(
      markup.indexOf("Event workspace"),
    );
    expect(markup).toContain("All events and integrations");
  });

  it("does not expose system management to event-only staff", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AppShellElement,
        {
          events,
          user: {
            displayName: "Riley Registration",
            email: "registration@imsda-events.test",
          },
        },
        createElement("p", null, "Workspace content"),
      ),
    );

    expect(markup).not.toContain("Global administration");
    expect(markup).not.toContain("System management");
    expect(markup).toContain("Event workspace");
  });
});
