import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistrationRecord } from "@/modules/registrations/repository";

const dependencies = vi.hoisted(() => ({
  resolveEventContext: vi.fn(),
  listDirectoryReviewEntries: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/use-accessible-dialog", () => ({
  useAccessibleDialog: () => ({ current: null }),
}));
vi.mock("@/modules/events/selection", () => ({ resolveEventContext: dependencies.resolveEventContext }));
vi.mock("@/modules/forms/directory-review", () => ({ listDirectoryReviewEntries: dependencies.listDirectoryReviewEntries }));

import DirectoryReviewPage from "@/app/(workspace)/people/directory-review/page";
import { PeopleWorkspace } from "@/components/people-workspace";

const event = { id: "event-1", name: "Synthetic Camporee", slug: "synthetic-camporee" };

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.listDirectoryReviewEntries.mockResolvedValue([{
    registrationId: "registration-1",
    confirmationCode: "REG-1",
    source: "CLUBS_DIRECTORY",
    fieldLabel: "Pathfinder club",
    freeText: "Made-Up Club",
  }]);
});

describe("directory review page access (#482)", () => {
  it("refuses staff without MANAGE_REGISTRATION and never loads the entries", async () => {
    dependencies.resolveEventContext.mockResolvedValue({ event, permissions: ["VIEW_REGISTRATIONS"] });
    const markup = renderToStaticMarkup(await DirectoryReviewPage({ searchParams: Promise.resolve({ event: "event-1" }) }));
    expect(markup).toContain("Directory review is restricted");
    expect(markup).not.toContain("Made-Up Club");
    expect(dependencies.listDirectoryReviewEntries).not.toHaveBeenCalled();
  });

  it("lists the entries for a registration manager", async () => {
    dependencies.resolveEventContext.mockResolvedValue({ event, permissions: ["MANAGE_REGISTRATION"] });
    const markup = renderToStaticMarkup(await DirectoryReviewPage({ searchParams: Promise.resolve({ event: "event-1" }) }));
    expect(markup).toContain("Made-Up Club");
    expect(dependencies.listDirectoryReviewEntries).toHaveBeenCalledWith("event-1");
  });
});

describe("people workspace directory review link (#482)", () => {
  const render = (canEdit: boolean) => renderToStaticMarkup(createElement(PeopleWorkspace, {
    eventId: "event-1",
    eventSlug: "synthetic-camporee",
    eventTimezone: "America/Chicago",
    waitlistEnabled: false,
    initialRegistrations: [] as RegistrationRecord[],
    canEdit,
    canEmail: false,
  }));

  it("shows the link only with the permission the page itself requires", () => {
    expect(render(true)).toContain("/people/directory-review?event=event-1");
    expect(render(false)).not.toContain("/people/directory-review");
  });
});
