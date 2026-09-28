import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The workspace renders the #473 draft-created banner, which reads the URL
// through the App Router; a static render has no router mounted.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/more/event-settings",
}));
import { EventSettingsWorkspace } from "@/components/event-settings-workspace";
import { UnpublishEventDialog } from "@/components/unpublish-event-dialog";
import { getEventPublishReadiness } from "@/modules/events/readiness";
import type { EventSettingsRecord } from "@/modules/events/repository";

const root = process.cwd();
const workspaceSource = readFileSync(path.join(root, "components/event-settings-workspace.tsx"), "utf8");

const baseEventFields = {
  id: "event-1",
  name: "Synthetic Retreat",
  slug: "synthetic-retreat",
  startsOn: "2027-10-08",
  endsOn: "2027-10-10",
  timezone: "America/Chicago",
  location: "Camp Heritage",
  capacity: 350,
  publicInfoUrl: null,
  supportContact: "registration@imsda.org",
  hotelName: null,
  hotelBookingUrl: null,
  hotelPhone: null,
  hotelGroupName: null,
  hotelRate: null,
  hotelInstructions: null,
  approvedPaymentInstructions: null,
  isPublished: true,
  registrationOpensOn: "2027-05-01",
  registrationClosesOn: "2027-10-01",
  waitlistEnabled: false,
  collectsShirtSizes: false,
  checksAdultBackgrounds: false,
  attendeeEditPolicy: "VERIFY_EVERY_EDIT" as const,
  billingMode: "ATTENDEE_PAY" as const,
  audience: "GENERAL" as const,
  seminarPreferenceClosesOn: null,
  seminarPreferenceSelfServiceLocked: false,
  autoPromoteWaitlist: false,
  publishedFormCount: 1,
  publishedForms: [],
  createdAt: "2027-01-01T00:00:00.000Z",
  updatedAt: "2027-01-01T00:00:00.000Z",
};

const baseEvent: EventSettingsRecord = {
  ...baseEventFields,
  readiness: getEventPublishReadiness(baseEventFields, baseEventFields.publishedFormCount),
};

/**
 * Unpublish can't happen as a side effect of saving settings (#471): the
 * checkbox that used to double as both a draft field and a live toggle is
 * gone, replaced by dedicated `publish()`/`unpublish()` calls the settings
 * `save()` handler never touches. This proves that structurally, at the
 * source level, since the confirm flow itself needs real interaction
 * (`useState`) that a static render can't exercise.
 */
describe("EventSettingsWorkspace never folds publish state into a settings save (#471)", () => {
  it("has no checkbox or other control bound to isPublished inside the settings form", () => {
    expect(workspaceSource).not.toMatch(/checked=\{draft\.isPublished\}/);
    expect(workspaceSource).not.toMatch(/update\("isPublished"/);
  });

  it("never sends isPublished in the settings save body", () => {
    // `isPublished` isn't part of the settings schema at all (#471); the
    // draft no longer carries it, and the save body never adds it back.
    expect(workspaceSource).not.toMatch(/isPublished:\s*draft\.isPublished/);
    expect(workspaceSource).not.toMatch(/isPublished:\s*mode ===/);
    expect(workspaceSource).not.toMatch(/isPublished: event\?\.isPublished/);
  });

  it("gates Publish on the saved settings, not unsaved edits or an in-flight save", () => {
    expect(workspaceSource).toContain("getEventPublishReadiness(savedDraft, publishedFormCount)");
    expect(workspaceSource).toContain("const publishBlockedBySave = dirty || saving;");
    expect(workspaceSource).toContain("disabled={!canPublish}");
    expect(workspaceSource).toContain("Save your changes first.");
  });

  it("publishes and unpublishes through their own endpoints, not the settings PATCH", () => {
    expect(workspaceSource).toContain("/publish`, { method: \"POST\" }");
    expect(workspaceSource).toContain("/unpublish`, { method: \"POST\" }");
  });

  it("renders the publish/unpublish control as a plain button, never a submit control, inside the settings form", () => {
    const markup = renderToStaticMarkup(createElement(EventSettingsWorkspace, {
      mode: "edit",
      initialEvent: baseEvent,
    }));
    // The unpublish button, not a checkbox, drives the published event's
    // lifecycle control.
    expect(markup).toContain("Unpublish event");
    expect(markup).not.toMatch(/<input[^>]*type="checkbox"[^>]*event-publish-toggle/);
  });

  it("shows a private draft with a disabled Publish button when the checklist isn't ready", () => {
    const markup = renderToStaticMarkup(createElement(EventSettingsWorkspace, {
      mode: "edit",
      initialEvent: { ...baseEvent, isPublished: false, supportContact: null },
    }));
    expect(markup).toContain("Private draft");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Publish event<\/button>/);
  });

  it("enables Publish for a ready, saved, unpublished event", () => {
    const markup = renderToStaticMarkup(createElement(EventSettingsWorkspace, {
      mode: "edit",
      initialEvent: { ...baseEvent, isPublished: false },
    }));
    expect(markup).toMatch(/Publish event<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Publish event<\/button>/);
  });
});

describe("UnpublishEventDialog (#471)", () => {
  it("names the event and states the one consequence in full when open", () => {
    const markup = renderToStaticMarkup(createElement(UnpublishEventDialog, {
      busy: false,
      eventName: "Synthetic Retreat",
      error: "",
      onCancel: () => {},
      onConfirm: () => {},
      open: true,
    }));
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Unpublish Synthetic Retreat?");
    expect(markup).toContain("Synthetic Retreat");
    expect(markup).toContain("closes");
    expect(markup).toContain("immediately");
    expect(markup).toContain("Unpublish event");
  });

  it("renders nothing while closed", () => {
    const markup = renderToStaticMarkup(createElement(UnpublishEventDialog, {
      busy: false,
      eventName: "Synthetic Retreat",
      error: "",
      onCancel: () => {},
      onConfirm: () => {},
      open: false,
    }));
    expect(markup).toBe("");
  });

  it("shows an inline error rather than silently failing", () => {
    const markup = renderToStaticMarkup(createElement(UnpublishEventDialog, {
      busy: false,
      eventName: "Synthetic Retreat",
      error: "The event could not be unpublished.",
      onCancel: () => {},
      onConfirm: () => {},
      open: true,
    }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The event could not be unpublished.");
  });
});
