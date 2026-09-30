import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getGroupRegistrationExperience: vi.fn(),
  listPublishedRegistrationInfoCards: vi.fn(),
  flowProps: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/group-registrations/repository", () => ({
  GroupRegistrationError: class extends Error { code = "X"; },
  getGroupRegistrationExperience: mocks.getGroupRegistrationExperience,
}));
vi.mock("@/modules/events/content-repository", () => ({
  listPublishedRegistrationInfoCards: mocks.listPublishedRegistrationInfoCards,
}));
vi.mock("@/components/group-registration-flow", () => ({
  GroupRegistrationFlow: (props: { topContent?: unknown }) => {
    mocks.flowProps(props);
    return createElement("div", null, props.topContent as never, "GROUP-FLOW-STUB");
  },
}));
vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));

import GroupPage from "@/app/(public)/register/[eventSlug]/group/page";

const ready = {
  problem: null,
  event: { name: "Synthetic Event", slug: "synthetic-event" },
  experience: { lifecycle: { phase: "OPEN", capacityDecision: "OPEN" } },
  billingNotice: null,
};

const render = async () => renderToStaticMarkup(await GroupPage({
  params: Promise.resolve({ eventSlug: "synthetic-event" }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getGroupRegistrationExperience.mockResolvedValue(ready);
});

describe("editable info cards on the group registration page", () => {
  it("passes undefined topContent when there are no cards", async () => {
    mocks.listPublishedRegistrationInfoCards.mockResolvedValue([]);
    await render();
    expect(mocks.listPublishedRegistrationInfoCards).toHaveBeenCalledWith("synthetic-event");
    expect(mocks.flowProps.mock.calls[0]![0].topContent).toBeUndefined();
  });

  it("passes the published registration cards to the form", async () => {
    mocks.listPublishedRegistrationInfoCards.mockResolvedValue([
      { id: "card-1", kind: "NOTICE", title: "Synthetic group notice", body: "Bring a synthetic item.", tone: "INFO", placement: "REGISTRATION_FORM", items: [], links: [] },
    ]);
    const markup = await render();
    expect(mocks.flowProps.mock.calls[0]![0].topContent).toBeTruthy();
    expect(markup).toContain("Synthetic group notice");
  });
});
