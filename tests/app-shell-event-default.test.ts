import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shell's selected event (#465): with no `?event=`, the switcher, nav
 * links and "chosen for you" notice follow the layout's `defaultEventId` —
 * the same `selectEventContext` decision the page makes — never `events[0]`.
 */

const navigation = vi.hoisted(() => ({ pathname: "/people", search: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("@/components/sign-out-button", () => ({
  SignOutButton: () => createElement("button", { type: "button" }, "Sign out"),
}));

import { AppShell } from "@/components/app-shell";

const AppShellElement = AppShell as ComponentType<
  Omit<Parameters<typeof AppShell>[0], "children">
>;

const events = [
  { id: "evt_draft_first", slug: "draft-first", name: "Draft First", permissions: ["VIEW_SENSITIVE_DATA"] as const },
  { id: "evt_chosen", slug: "chosen", name: "Chosen Event", permissions: ["VIEW_SENSITIVE_DATA"] as const },
];
const staff = { displayName: "Synthetic Staff", email: "staff@imsda-events.test", globalRole: null };
const admin = { ...staff, globalRole: "SYSTEM_ADMIN" as const };

function render(props: Partial<Parameters<typeof AppShell>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(
      AppShellElement,
      { events, user: staff, defaultEventId: "evt_chosen", autoSelected: true, ...props },
      createElement("p", null, "Workspace content"),
    ),
  );
}

beforeEach(() => {
  navigation.pathname = "/people";
  navigation.search = "";
});

describe("AppShell default event (#465)", () => {
  it("uses the layout's default, not events[0], for the switcher and nav links when there's no ?event=", () => {
    const markup = render();

    expect(markup).toContain('<option value="evt_chosen" selected="">Chosen Event</option>');
    expect(markup).toContain('href="/people?event=evt_chosen"');
    expect(markup).not.toContain("?event=evt_draft_first");
  });

  it("shows the notice once, on any workspace page reached without ?event=, when the choice was automatic", () => {
    const markup = render();

    expect(markup.match(/Continuing with/g)).toHaveLength(1);
    expect(markup).toContain("Continuing with <strong>Chosen Event</strong>");
    expect(markup).toContain('href="/select-event">Switch event');
  });

  it("points a system administrator's Switch event link at /admin (the picker sends admins there)", () => {
    const markup = render({ user: admin });

    expect(markup).toContain('href="/admin">Switch event');
  });

  it("shows no notice when ?event= was given, and follows the requested event", () => {
    navigation.search = "event=evt_draft_first";
    const markup = render();

    expect(markup).not.toContain("Continuing with");
    expect(markup).toContain('href="/people?event=evt_draft_first"');
  });

  it("shows no notice when the default wasn't an automatic choice (the account's only event)", () => {
    expect(render({ autoSelected: false })).not.toContain("Continuing with");
  });

  it("shows no notice on /admin, which isn't event-scoped", () => {
    navigation.pathname = "/admin";
    expect(render({ user: admin })).not.toContain("Continuing with");
  });

  it("selects nothing (with a placeholder) instead of events[0] when nothing could be chosen automatically", () => {
    navigation.pathname = "/admin";
    const markup = render({ user: admin, defaultEventId: null, autoSelected: false });

    expect(markup).toContain("Choose an event");
    expect(markup).not.toContain('selected="">Draft First');
    expect(markup).not.toContain("?event=evt_draft_first");
  });
});
