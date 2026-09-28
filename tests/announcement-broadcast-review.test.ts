import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnnouncementBroadcastReviewFacts, deliveryTimingLabel } from "@/components/announcement-broadcast-review";
import type { AnnouncementBroadcastPreview } from "@/modules/communications/types";

function preview(overrides: Partial<AnnouncementBroadcastPreview> = {}): AnnouncementBroadcastPreview {
  return {
    announcementId: "announcement-1",
    title: "Friday arrival information",
    audienceLabel: "All active registrations (submitted or confirmed) for this event",
    recipientCount: 42,
    deliveryMode: "LOCAL_CAPTURE",
    sendTiming: "IMMEDIATE",
    generatedAt: "2026-09-28T04:06:05.000Z",
    ...overrides,
  };
}

/**
 * The announcement broadcast review dialog's body (#472): the subject,
 * audience, recipient count, and delivery mode staff must see before an
 * event-wide send happens. This renders exactly what
 * `CommunicationsWorkspace` passes to the shared `ConfirmDialog`, without
 * mounting the whole stateful workspace.
 */
describe("AnnouncementBroadcastReviewFacts (#472)", () => {
  it("shows the subject, audience, and recipient count from the preview", () => {
    const html = renderToStaticMarkup(createElement(AnnouncementBroadcastReviewFacts, {
      preview: preview(),
    }));

    expect(html).toContain("Friday arrival information");
    expect(html).toContain("All active registrations (submitted or confirmed) for this event");
    expect(html).toContain("42");
  });

  it("describes external email delivery as sending immediately", () => {
    const html = renderToStaticMarkup(createElement(AnnouncementBroadcastReviewFacts, {
      preview: preview({ deliveryMode: "EXTERNAL_EMAIL" }),
    }));

    expect(html).toContain("Sends immediately by email");
  });

  it("makes clear a disabled delivery mode sends nothing", () => {
    const html = renderToStaticMarkup(createElement(AnnouncementBroadcastReviewFacts, {
      preview: preview({ deliveryMode: "DISABLED" }),
    }));

    expect(html).toContain("delivery is off");
  });
});

describe("deliveryTimingLabel (#472)", () => {
  it("covers every delivery mode with a send-timing sentence", () => {
    expect(deliveryTimingLabel("EXTERNAL_EMAIL")).toMatch(/immediately/i);
    expect(deliveryTimingLabel("LOCAL_CAPTURE")).toMatch(/immediately/i);
    expect(deliveryTimingLabel("DISABLED")).toMatch(/immediately/i);
  });
});
