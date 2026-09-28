import { describe, expect, it, vi } from "vitest";

describe("/events redirects to the public events home (#470)", () => {
  it("permanently redirects /events to / at the config level", async () => {
    vi.resetModules();
    const nextConfig = (await import("../next.config")).default;
    const redirectRules = (await nextConfig.redirects?.()) ?? [];

    const eventsRedirect = redirectRules.find((rule) => rule.source === "/events");
    expect(eventsRedirect).toBeDefined();
    expect(eventsRedirect).toMatchObject({
      destination: "/",
      permanent: true,
    });
  });
});
