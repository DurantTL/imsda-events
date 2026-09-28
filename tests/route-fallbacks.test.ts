import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: vi.fn() }));

import { SESSION_COOKIE_NAME } from "@/modules/access/session-store";

async function redirectRules() {
  vi.resetModules();
  const nextConfig = (await import("../next.config")).default;
  return (await nextConfig.redirects?.()) ?? [];
}

/** The same matcher options Next.js uses for config redirects. */
function matches(source: string, pathname: string) {
  return getPathMatch(source, { removeUnnamedParams: true, strict: true })(pathname) !== false;
}

describe("/events redirects to the public events home (#470)", () => {
  it("permanently redirects exactly /events to / at the config level", async () => {
    const eventsRedirect = (await redirectRules()).find((rule) => rule.destination === "/");
    expect(eventsRedirect).toMatchObject({
      source: "/events",
      destination: "/",
      permanent: true,
    });
    expect(matches(eventsRedirect!.source, "/events")).toBe(true);
    // Event landing pages live under /events/<slug> and must never redirect.
    expect(matches(eventsRedirect!.source, "/events/some-slug")).toBe(false);
    expect(matches(eventsRedirect!.source, "/events/some-slug/register")).toBe(false);
  });
});

describe("signed-out /check-in goes to staff sign-in and back (#470)", () => {
  it("redirects only when the staff session cookie is missing, keeping the event", async () => {
    const checkInRules = (await redirectRules()).filter((rule) => rule.source === "/check-in");
    expect(checkInRules).toHaveLength(2);
    for (const rule of checkInRules) {
      expect(rule.permanent).toBe(false);
      expect(rule.missing).toEqual([{ type: "cookie", key: SESSION_COOKIE_NAME }]);
      expect(rule.destination.startsWith("/login?next=/check-in")).toBe(true);
      expect(matches(rule.source, "/check-in")).toBe(true);
      expect(matches(rule.source, "/check-in/anything")).toBe(false);
    }
    // The event-preserving rule comes first so it wins when ?event= is present.
    expect(checkInRules[0].has).toEqual([{ type: "query", key: "event", value: "(?<event>[A-Za-z0-9_-]{1,64})" }]);
    expect(checkInRules[0].destination).toBe("/login?next=/check-in%3Fevent%3D:event");
    expect(checkInRules[1].has).toBeUndefined();
    expect(checkInRules[1].destination).toBe("/login?next=/check-in");
  });
});
