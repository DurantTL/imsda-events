import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPublicClubs: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/organizations/public-club-directory", () => ({
  listPublicClubs: mocks.listPublicClubs,
}));

import PublicClubsPage from "@/app/(public)/clubs/page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPublicClubs.mockResolvedValue([]);
});

describe("public clubs page header and back link (#470)", () => {
  it("keeps the header logo on the Events site and labels the back link for where it goes", async () => {
    const html = renderToStaticMarkup(await PublicClubsPage());

    expect(html).not.toContain("imsda.org");
    expect(html).toContain("Events home");
    expect(html).not.toContain("All events");
    expect(html.match(/href="\/"/g)?.length).toBe(2);
  });
});
