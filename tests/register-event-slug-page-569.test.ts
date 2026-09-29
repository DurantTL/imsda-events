import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPublicEventLanding: vi.fn() }));
vi.mock("@/modules/events/public-repository", () => mocks);
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import RegisterEventPage, { metadata } from "@/app/(public)/register/[eventSlug]/page";

describe("/register/[eventSlug] (#569)", () => {
  beforeEach(() => mocks.getPublicEventLanding.mockReset());

  it("redirects a real event slug to its public event page", async () => {
    mocks.getPublicEventLanding.mockResolvedValue({ event: { slug: "womens-retreat" } });
    await expect(RegisterEventPage({ params: Promise.resolve({ eventSlug: "womens-retreat" }) }))
      .rejects.toThrow("REDIRECT:/events/womens-retreat");
  });

  it("renders the branded not-found page for an unknown slug, marked noindex", async () => {
    mocks.getPublicEventLanding.mockResolvedValue(null);
    const html = renderToStaticMarkup(await RegisterEventPage({ params: Promise.resolve({ eventSlug: "no-such-event" }) }));
    expect(html).toContain("no-such-event");
    expect(html).toContain("Event not found");
    expect(html).toContain("https://imsda.org/events/");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("does not echo an unsafe slug", async () => {
    mocks.getPublicEventLanding.mockResolvedValue(null);
    const html = renderToStaticMarkup(await RegisterEventPage({ params: Promise.resolve({ eventSlug: "<b>Bad Slug</b>" }) }));
    expect(html).not.toContain("Bad Slug");
    expect(html).toContain("We couldn&#x27;t find that event");
  });
});
