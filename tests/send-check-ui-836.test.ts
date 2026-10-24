import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AnnouncementBroadcastReviewFacts,
  announcementBroadcastConfirmState,
} from "@/components/announcement-broadcast-review";
import { announcementDraftBaseline, announcementDraftIsDirty, blankAnnouncementValues } from "@/components/announcement-draft-dirty";
import { SendCheckPanel, sendCheckSummary } from "@/components/send-check-panel";
import { ANNOUNCEMENT_CHECK_ANCHORS, runSendCheck, type SendCheckResult } from "@/modules/communications/send-check";
import type { AnnouncementBroadcastPreview } from "@/modules/communications/types";

const body = "Check-in opens at four in the main lodge, with parking by the lake.";
const clean = runSendCheck({ subject: "Friday arrival", body, preheader: "Where to park." });
const withWarning = runSendCheck({ subject: "x".repeat(90), body, preheader: "Where to park.", anchors: ANNOUNCEMENT_CHECK_ANCHORS });
const withError = runSendCheck({ subject: "", body: "", anchors: ANNOUNCEMENT_CHECK_ANCHORS });

function preview(sendCheck: SendCheckResult, overrides: Partial<AnnouncementBroadcastPreview> = {}): AnnouncementBroadcastPreview {
  return {
    announcementId: "announcement-1",
    title: "Friday arrival information",
    audienceLabel: "All active registrations (submitted or confirmed) for this event",
    activeRegistrationCount: 3,
    recipientCount: 3,
    skippedNoEmailCount: 0,
    skippedOptedOutCount: 0,
    skippedOptedOutEventCount: 0,
    skippedOptedOutAllCount: 0,
    essential: false,
    essentialOptedOutReachedCount: 0,
    deliveryMode: "LOCAL_CAPTURE",
    templateEnabled: true,
    suppressed: false,
    attachments: [],
    attachmentProblem: null,
    carriesFiles: false,
    preheader: "Where to park.",
    sendCheck,
    fingerprint: "a".repeat(64),
    sendTiming: "IMMEDIATE",
    generatedAt: "2026-10-08T12:00:00.000Z",
    ...overrides,
  };
}

describe("the send check panel (#836)", () => {
  it("summarises the counts, and says plainly when there is nothing", () => {
    expect(sendCheckSummary(clean)).toBe("No problems found.");
    expect(sendCheckSummary(withWarning)).toBe("1 warning");
    expect(sendCheckSummary(runSendCheck({ subject: "", body: "", preheader: "" }))).toBe("2 errors, 1 suggestion");
  });

  it("groups by severity and writes the severity out, never colour alone", () => {
    const html = renderToStaticMarkup(createElement(SendCheckPanel, { result: runSendCheck({ subject: "", body: "![](https://cdn.example.test/a.png)", preheader: "" }), idPrefix: "t" }));
    expect(html).toContain("Errors (");
    expect(html).toContain("Warnings (");
    expect(html).toContain("Suggestions (");
    expect(html.indexOf("Errors (")).toBeLessThan(html.indexOf("Warnings ("));
    expect(html.indexOf("Warnings (")).toBeLessThan(html.indexOf("Suggestions ("));
    expect(html).toContain('aria-labelledby="t-send-check-title"');
  });

  it("offers a Go to button only for a finding with an anchor, when the page can jump", () => {
    const jumpable = renderToStaticMarkup(createElement(SendCheckPanel, { result: withWarning, idPrefix: "a", onJump: () => undefined, fieldLabels: { subject: "title", body: "message", preheader: "preview line" } }));
    expect(jumpable).toContain("Go to title");
    const noJump = renderToStaticMarkup(createElement(SendCheckPanel, { result: withWarning, idPrefix: "a" }));
    expect(noJump).not.toContain("Go to");
    const noAnchors = renderToStaticMarkup(createElement(SendCheckPanel, { result: runSendCheck({ subject: "x".repeat(90), body }), idPrefix: "a", onJump: () => undefined }));
    expect(noAnchors).not.toContain("Go to");
  });

  it("renders nothing for a group with no findings", () => {
    const html = renderToStaticMarkup(createElement(SendCheckPanel, { result: withWarning, idPrefix: "a" }));
    expect(html).not.toContain("Errors (");
    expect(html).not.toContain("Suggestions (");
  });
});

describe("the review dialog's send check (#836)", () => {
  const state = (sendCheck: SendCheckResult, warningsAcknowledged?: boolean) => announcementBroadcastConfirmState({ loading: false, error: "", preview: preview(sendCheck), warningsAcknowledged });

  it("lets a clean announcement send, suggestions included", () => {
    expect(state(clean).canConfirm).toBe(true);
    expect(state(runSendCheck({ subject: "Friday arrival", body })).canConfirm).toBe(true);
  });

  it("never lets an error send, whatever was ticked", () => {
    expect(state(withError, true)).toMatchObject({ canConfirm: false });
    expect(state(withError, true).reason).toContain("Fix the errors");
  });

  it("holds a warning until the acknowledgement is ticked", () => {
    expect(state(withWarning)).toMatchObject({ canConfirm: false });
    expect(state(withWarning).reason).toContain("Acknowledge the warnings");
    expect(state(withWarning, false).canConfirm).toBe(false);
    expect(state(withWarning, true).canConfirm).toBe(true);
  });

  it("shows the preview line, the findings, and the acknowledgement only when there are warnings and no errors", () => {
    const render = (p: AnnouncementBroadcastPreview) => renderToStaticMarkup(createElement(AnnouncementBroadcastReviewFacts, { preview: p }));
    const warned = render(preview(withWarning));
    expect(warned).toContain("Preview line");
    expect(warned).toContain("Where to park.");
    expect(warned).toContain("Warnings (1)");
    expect(warned).toContain("I have read the warnings");
    expect(warned).not.toContain("Go to");
    expect(render(preview(clean))).not.toContain("I have read the warnings");
    expect(render(preview(withError))).not.toContain("I have read the warnings");
    expect(render(preview(clean, { preheader: null }))).toContain("None. Inboxes will show");
  });
});

describe("the announcement composer (#836)", () => {
  it("counts a changed preview line as an unsaved edit", () => {
    const baseline = announcementDraftBaseline({ ...blankAnnouncementValues, title: "Title", body: "A body" }, []);
    expect(announcementDraftIsDirty(baseline, { ...blankAnnouncementValues, title: "Title", body: "A body" }, [])).toBe(false);
    expect(announcementDraftIsDirty(baseline, { ...blankAnnouncementValues, title: "Title", body: "A body", preheader: "A line" }, [])).toBe(true);
    // A draft from before the field existed has no preview line, which is the same as a blank one.
    expect(announcementDraftIsDirty(announcementDraftBaseline({ title: "Title", body: "A body", priority: "NORMAL" }, []), { ...blankAnnouncementValues, title: "Title", body: "A body" }, [])).toBe(false);
  });

  it("wires the check's anchors to real field ids in the editor and the composer", () => {
    const workspace = readFileSync(new URL("../components/communications-workspace.tsx", import.meta.url), "utf8");
    for (const id of ["template-subject", "template-body", "template-preheader", "announcement-title", "announcement-body", "announcement-preheader"]) {
      expect(workspace, id).toContain(`id="${id}"`);
    }
    expect(ANNOUNCEMENT_CHECK_ANCHORS).toEqual({ subject: "announcement-title", body: "announcement-body", preheader: "announcement-preheader" });
  });
});
