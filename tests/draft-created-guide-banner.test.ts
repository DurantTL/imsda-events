import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const replace = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => currentSearchParams,
}));

import { DraftCreatedGuideBanner } from "@/components/draft-created-guide-banner";

function render(eventId: string) {
  return renderToStaticMarkup(createElement(DraftCreatedGuideBanner, { eventId }));
}

describe("draft created guide banner", () => {
  afterEach(() => {
    currentSearchParams = new URLSearchParams();
    push.mockClear();
    replace.mockClear();
  });

  it("renders nothing when created=1 is absent", () => {
    currentSearchParams = new URLSearchParams("event=event_1");
    expect(render("event_1")).toBe("");
  });

  it("renders the banner with links for all three next steps when created=1 is present", () => {
    currentSearchParams = new URLSearchParams("event=event_1&created=1");
    const markup = render("event_1");

    expect(markup).toContain("Draft created");
    expect(markup).toContain("Complete public details");
    expect(markup).toContain("Build and test the registration form");
    expect(markup).toContain("Review readiness and publish");

    // Step 2 links into the registration builder for this event.
    expect(markup).toContain("/registration-builder?event=event_1");
    // Step 3 points into the existing readiness panel rather than repeating it.
    expect(markup).toContain("#event-readiness-panel");
    // The staff guide is at least named, since no in-app help page exists yet.
    expect(markup).toContain("docs/STAFF-EVENT-WORKFLOW.md");
  });

  it("encodes the event id used in the registration builder link", () => {
    currentSearchParams = new URLSearchParams("event=event%201&created=1");
    const markup = render("event 1");
    expect(markup).toContain("/registration-builder?event=event%201");
  });
});
