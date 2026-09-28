import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AnnouncementBroadcastReviewFacts,
  announcementBroadcastConfirmState,
  deliveryTimingLabel,
} from "@/components/announcement-broadcast-review";
import type { AnnouncementBroadcastPreview } from "@/modules/communications/types";

function preview(overrides: Partial<AnnouncementBroadcastPreview> = {}): AnnouncementBroadcastPreview {
  return {
    announcementId: "announcement-1",
    title: "Friday arrival information",
    audienceLabel: "All active registrations (submitted or confirmed) for this event",
    activeRegistrationCount: 42,
    recipientCount: 42,
    skippedNoEmailCount: 0,
    deliveryMode: "LOCAL_CAPTURE",
    templateEnabled: true,
    suppressed: false,
    fingerprint: "a".repeat(64),
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
  it("shows the announcement title, audience, and recipient count from the preview", () => {
    const html = renderToStaticMarkup(createElement(AnnouncementBroadcastReviewFacts, {
      preview: preview(),
    }));

    expect(html).toContain("Announcement title");
    expect(html).not.toContain("Subject");
    expect(html).not.toContain("Skipped");
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

describe("AnnouncementBroadcastReviewFacts skipped and suppressed states (#472)", () => {
  it("shows registrations skipped for having no contact email", () => {
    const html = renderToStaticMarkup(createElement(AnnouncementBroadcastReviewFacts, {
      preview: preview({ activeRegistrationCount: 44, recipientCount: 42, skippedNoEmailCount: 2 }),
    }));

    expect(html).toContain("Skipped");
    expect(html).toContain("2 registrations have no contact email");
  });

  it("warns that a disabled template suppresses every message", () => {
    const html = renderToStaticMarkup(createElement(AnnouncementBroadcastReviewFacts, {
      preview: preview({ templateEnabled: false, suppressed: true }),
    }));

    expect(html).toContain("template is turned off");
    expect(html).toContain("suppressed");
  });
});

describe("announcementBroadcastConfirmState (#472)", () => {
  it("keeps Send disabled while there is no open review", () => {
    expect(announcementBroadcastConfirmState(null).canConfirm).toBe(false);
  });

  it("keeps Send disabled while the review is loading", () => {
    expect(announcementBroadcastConfirmState({ loading: true, error: "", preview: null }).canConfirm).toBe(false);
  });

  it("keeps Send disabled when the preview is null", () => {
    const state = announcementBroadcastConfirmState({ loading: false, error: "", preview: null });
    expect(state.canConfirm).toBe(false);
    expect(state.reason).toMatch(/hasn't loaded/);
  });

  it("keeps Send disabled after the preview request failed", () => {
    const state = announcementBroadcastConfirmState({
      loading: false,
      error: "Unable to review this announcement.",
      preview: null,
    });
    expect(state.canConfirm).toBe(false);
  });

  it("keeps Send disabled and explains why when there are 0 recipients", () => {
    const none = announcementBroadcastConfirmState({
      loading: false,
      error: "",
      preview: preview({ activeRegistrationCount: 0, recipientCount: 0 }),
    });
    expect(none.canConfirm).toBe(false);
    expect(none.reason).toMatch(/no active registrations/i);

    const noEmail = announcementBroadcastConfirmState({
      loading: false,
      error: "",
      preview: preview({ activeRegistrationCount: 2, recipientCount: 0, skippedNoEmailCount: 2 }),
    });
    expect(noEmail.canConfirm).toBe(false);
    expect(noEmail.reason).toMatch(/contact email/i);
  });

  it("enables Send once a successful preview reaches at least one recipient", () => {
    expect(announcementBroadcastConfirmState({ loading: false, error: "", preview: preview() })).toEqual({
      canConfirm: true,
      reason: "",
    });
  });
});
