import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/more/event-settings",
}));
import { EventActivityPanel } from "@/components/event-activity-panel";
import { EventSettingsWorkspace } from "@/components/event-settings-workspace";
import { getEventPublishReadiness } from "@/modules/events/readiness";
import type { EventSettingsRecord } from "@/modules/events/repository";
import {
  activityActionAppliesTo,
  appliesToKind,
  eventKindFromAudience,
  eventSettingsSections,
  filterActivityForKind,
  resolveSectionPlacement,
  sectionsWithNonDefaultValues,
  selectActivity,
  type EventSettingsSectionId,
  type EventTypeContext,
} from "@/modules/events/settings-sections";

const none = new Set<EventSettingsSectionId>();
const club: EventTypeContext = { kind: "club", billingMode: "DEFERRED_ORGANIZATION_INVOICE" };
const general: EventTypeContext = { kind: "general", billingMode: "ATTENDEE_PAY" };

describe("event settings sections by event type (#624)", () => {
  it("maps the audience to an event kind", () => {
    expect(eventKindFromAudience("CLUB")).toBe("club");
    expect(eventKindFromAudience("GENERAL")).toBe("general");
    expect(eventKindFromAudience(undefined)).toBe("general");
  });

  it("puts each section in view for the types it applies to and under More settings for the rest", () => {
    const placement = (id: EventSettingsSectionId, context: EventTypeContext) => resolveSectionPlacement(id, context, none);
    for (const id of [
      "basics",
      "registration-timing",
      "audience-billing",
      "public-information",
      "locations",
      "attendee-edit-policy",
      "shirt-sizes",
      "lodging",
      "adult-background-checks",
    ] as const) {
      expect(placement(id, club)).toBe("primary");
      expect(placement(id, general)).toBe("primary");
    }
    expect(placement("seminar-preferences", general)).toBe("primary");
    expect(placement("seminar-preferences", club)).toBe("more");
  });

  it("hides payment instructions by billing mode, whatever the audience", () => {
    const placement = (context: EventTypeContext) => resolveSectionPlacement("payment-instructions", context, none);
    expect(placement({ kind: "general", billingMode: "ATTENDEE_PAY" })).toBe("primary");
    expect(placement({ kind: "club", billingMode: "ATTENDEE_PAY" })).toBe("primary");
    expect(placement({ kind: "general", billingMode: "DEFERRED_ORGANIZATION_INVOICE" })).toBe("more");
    expect(placement({ kind: "club", billingMode: "DEFERRED_ORGANIZATION_INVOICE" })).toBe("more");
    expect(resolveSectionPlacement(
      "payment-instructions",
      club,
      sectionsWithNonDefaultValues({ approvedPaymentInstructions: "Pay by check." }),
    )).toBe("primary");
  });

  it("never hides the publish, sharing, delete, or save sections for any type", () => {
    for (const id of ["readiness", "sharing", "danger-zone", "save"] as const) {
      expect(eventSettingsSections[id]).toBe("both");
    }
  });

  it("keeps a hidden section in view when it holds a non-default value", () => {
    const nonDefault = sectionsWithNonDefaultValues({ seminarPreferenceClosesOn: "2027-01-05" });
    expect(resolveSectionPlacement("seminar-preferences", club, nonDefault)).toBe("primary");
    expect(resolveSectionPlacement("seminar-preferences", club, sectionsWithNonDefaultValues({ seminarPreferenceSelfServiceLocked: true }))).toBe("primary");
    expect(resolveSectionPlacement("seminar-preferences", club, none)).toBe("more");
  });

  it("treats default values as default", () => {
    expect(sectionsWithNonDefaultValues({
      attendeeEditPolicy: "VERIFY_EVERY_EDIT",
      approvedPaymentInstructions: "  ",
      seminarPreferenceClosesOn: null,
      seminarPreferenceSelfServiceLocked: false,
      collectsShirtSizes: false,
      checksAdultBackgrounds: false,
      hotelName: null,
    }).size).toBe(0);
    expect(sectionsWithNonDefaultValues({ attendeeEditPolicy: "TIERED" }).has("attendee-edit-policy")).toBe(true);
    expect(sectionsWithNonDefaultValues({ hotelName: "Synthetic Inn" }).has("lodging")).toBe(true);
  });

  it("filters only low-risk configuration noise from activity", () => {
    expect(activityActionAppliesTo("CLUB_ASSIGNMENTS_BATCH_ENQUEUED")).toBe("club");
    expect(activityActionAppliesTo("PROMO_CODE_CREATED")).toBe("general");
    expect(activityActionAppliesTo("SHIRT_SIZE_REQUEST_BATCH_ENQUEUED")).toBe("general");
    expect(activityActionAppliesTo("BALANCE_REMINDER_BATCH_ENQUEUED")).toBe("general");
    expect(activityActionAppliesTo("REGISTRATION_CREATED")).toBe("both");
    const entries = [{ action: "CLUB_ASSIGNMENTS_BATCH_ENQUEUED" }, { action: "PROMO_CODE_CREATED" }, { action: "TAG_CREATED" }];
    expect(filterActivityForKind(entries, "club").map((e) => e.action)).toEqual(["CLUB_ASSIGNMENTS_BATCH_ENQUEUED", "TAG_CREATED"]);
    expect(filterActivityForKind(entries, "general").map((e) => e.action)).toEqual(["PROMO_CODE_CREATED", "TAG_CREATED"]);
    expect(appliesToKind("both", "club")).toBe(true);
  });

  it("never filters money, access, public, delete, staff, or background-check activity", () => {
    const sensitive = [
      "REFUND_RECORDED",
      "SQUARE_PAYMENT_MANUALLY_MATCHED",
      "SQUARE_EXTERNAL_PAYMENT_APPLIED",
      "REGISTRATION_ADJUSTMENT_ADDED",
      "REGISTRATION_CARD_SURCHARGE_APPLIED",
      "REGISTRATION_ACCESS_REVOKED",
      "PRIVATE_LINK_ANSWERS_UPDATED",
      "PUBLIC_REGISTRATION_CONTACT_UPDATED",
      "PUBLIC_ATTENDEE_SHIRT_SIZES_CONFIRMED",
      "ORGANIZATION_DELETED",
      "EVENT_DELETED",
      "STAFF_MFA_RESET",
      "STAFF_PROFILE_UPDATED",
      "BACKGROUND_CHECK_UPLOADED",
      // Even a name that starts like a filtered prefix stays visible.
      "PROMO_CODE_REFUND_ADJUSTED",
      "BALANCE_REMINDER_BATCH_PAYMENT_FAILED",
      "CLUB_ASSIGNMENTS_BATCH_STAFF_PERMISSION_CHANGED",
    ];
    for (const action of sensitive) {
      expect(activityActionAppliesTo(action), action).toBe("both");
      expect(filterActivityForKind([{ action }], "club")).toHaveLength(1);
      expect(filterActivityForKind([{ action }], "general")).toHaveLength(1);
    }
  });
});

describe("activity selection and panel (#624)", () => {
  const entry = (id: string, action: string) => ({
    id,
    action,
    summary: `Synthetic ${id}`,
    actorName: "Synthetic Staff",
    createdAt: "2027-01-01T00:00:00.000Z",
  });
  const all = [entry("a", "PROMO_CODE_CREATED"), entry("b", "TAG_CREATED"), entry("c", "SHIRT_SIZE_REQUEST_BATCH_ENQUEUED")];

  it("counts filtering before the slice", () => {
    const sliced = selectActivity(all, "club", false, 1);
    expect(sliced.entries.map((e) => e.id)).toEqual(["b"]);
    expect(sliced.filtered).toBe(true);
    // Nothing hidden by type: the slice alone must not read as "filtered".
    const onlyBoth = selectActivity([entry("x", "TAG_CREATED"), entry("y", "TAG_UPDATED")], "club", false, 1);
    expect(onlyBoth.filtered).toBe(false);
  });

  it("shows every entry with ?activity=all", () => {
    const selection = selectActivity(all, "club", true);
    expect(selection.entries).toHaveLength(3);
    const markup = renderToStaticMarkup(createElement(EventActivityPanel, { eventId: "event-1", kind: "club", selection, showAll: true }));
    for (const id of ["a", "b", "c"]) expect(markup).toContain(`Synthetic ${id}`);
    expect(markup).toContain("Show only club event activity");
    expect(markup).not.toContain("Show all activity");
  });

  it("hides other-type entries by default and links to show all", () => {
    const selection = selectActivity(all, "club", false);
    const markup = renderToStaticMarkup(createElement(EventActivityPanel, { eventId: "event-1", kind: "club", selection, showAll: false }));
    expect(markup).toContain("Synthetic b");
    expect(markup).not.toContain("Synthetic a");
    expect(markup).toContain("/more?event=event-1&amp;activity=all");
  });

  it("says so, with a link, when every entry was filtered out", () => {
    const selection = selectActivity([entry("a", "PROMO_CODE_CREATED")], "club", false);
    expect(selection.allFilteredOut).toBe(true);
    const markup = renderToStaticMarkup(createElement(EventActivityPanel, { eventId: "event-1", kind: "club", selection, showAll: false }));
    expect(markup).toContain("Every recent entry is for other kinds of events");
    expect(markup).toContain("Show all activity");
    expect(markup).not.toContain("No activity has been recorded");
  });
});

const baseFields = {
  id: "event-1",
  name: "Synthetic Camporee",
  slug: "synthetic-camporee",
  startsOn: "2027-10-08",
  endsOn: "2027-10-10",
  timezone: "America/Chicago",
  location: "Camp Heritage",
  capacity: 350,
  publicInfoUrl: null,
  supportContact: "registration@imsda.org",
  tagline: null,
  subtitle: null,
  helpEmail: null,
  hotelName: null,
  hotelBookingUrl: null,
  hotelPhone: null,
  hotelGroupName: null,
  hotelRate: null,
  hotelInstructions: null,
  approvedPaymentInstructions: null,
  isPublished: false,
  registrationOpensOn: "2027-05-01",
  registrationClosesOn: "2027-10-01",
  waitlistEnabled: false,
  collectsShirtSizes: false,
  checksAdultBackgrounds: false,
  attendeeEditPolicy: "VERIFY_EVERY_EDIT" as const,
  billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const,
  audience: "CLUB" as const,
  seminarPreferenceClosesOn: null,
  seminarPreferenceSelfServiceLocked: false,
  autoPromoteWaitlist: false,
  publishedFormCount: 1,
  publishedForms: [],
  createdAt: "2027-01-01T00:00:00.000Z",
  updatedAt: "2027-01-01T00:00:00.000Z",
};

function render(overrides: Partial<EventSettingsRecord> = {}, canDeleteEvent = false) {
  const fields = { ...baseFields, ...overrides } as typeof baseFields;
  const event = {
    ...fields,
    readiness: getEventPublishReadiness(fields, fields.publishedFormCount),
    warnings: [],
  } as EventSettingsRecord;
  return renderToStaticMarkup(createElement(EventSettingsWorkspace, { mode: "edit", initialEvent: event, canDeleteEvent }));
}

/** The markup inside the "More settings" disclosure, or "" when it is absent. */
function moreSettings(markup: string) {
  const start = markup.indexOf('<details class="settings-block panel event-more-settings"');
  if (start === -1) return "";
  return markup.slice(start, markup.indexOf("</details>", start));
}

describe("event settings render by event type (#624)", () => {
  it("keeps hidden fields in the form, inside the closed More settings, so a save still sends them", () => {
    const markup = render();
    const more = moreSettings(markup);
    expect(markup).toMatch(/<details class="settings-block panel event-more-settings"(?![^>]*\sopen)/);
    expect(more).toContain("Seminar preference deadline");
    expect(more).toContain("Approved payment instructions");
    // The save body spreads the whole draft, hidden fields included.
    const source = readFileSync(path.join(process.cwd(), "components/event-settings-workspace.tsx"), "utf8");
    expect(source).toMatch(/body: JSON\.stringify\(\{\s*\.\.\.draft,/);
  });

  it("renders a saved non-default value outside the disclosure on a club event", () => {
    const markup = render({ approvedPaymentInstructions: "Pay by check to the conference office.", seminarPreferenceClosesOn: "2027-09-01" });
    const more = moreSettings(markup);
    expect(more).not.toContain("Approved payment instructions");
    expect(more).not.toContain("Seminar preference deadline");
    expect(markup).toContain("Approved payment instructions");
    expect(markup).toContain("Seminar preference deadline");
  });

  it("shows the club-applicable sections in view and keeps Danger zone (system admins) and Save visible", () => {
    const markup = render({}, true);
    const more = moreSettings(markup);
    for (const label of ["Attendee edit verification", "Collect a shirt size", "Sterling Volunteers", "Hotel name"]) {
      expect(markup).toContain(label);
      expect(more).not.toContain(label);
    }
    expect(markup).toContain("Danger zone");
    expect(markup).toContain("Save event settings");
  });

  it("puts only what this event does not use under More settings for an attendee-pay general event", () => {
    const markup = render({ audience: "GENERAL", billingMode: "ATTENDEE_PAY" });
    // Every option applies, so there is nothing to collapse.
    expect(moreSettings(markup)).toBe("");
    expect(markup).toContain("Approved payment instructions");
    expect(markup).toContain("Seminar preference deadline");
  });
});

describe("Delete event panel (#704)", () => {
  it("is offered to system administrators only", () => {
    expect(render({}, false)).not.toContain("Delete event");
    expect(render({}, true)).toContain("Delete event");
  });
});

describe("Event settings save and publish clarity (#742)", () => {
  it("has no second Event settings title: the staff header carries the H1", () => {
    const markup = render();
    expect(markup).not.toMatch(/<h1/);
    expect(markup).not.toMatch(/<h2[^>]*>Event settings<\/h2>/);
  });

  it("makes Save event settings the one submit button, in a sticky bar", () => {
    const markup = render();
    expect(markup.match(/type="submit"/g)).toHaveLength(1);
    expect(markup).toContain('class="event-savebar"');
    expect(markup.slice(markup.indexOf('class="event-savebar"'))).toContain("Save event settings");
    expect(markup).toContain("Saving never publishes the event");
  });

  it("explains the first missing requirement and points at its control instead of a dead button", () => {
    const markup = render({ supportContact: null });
    expect(markup).toContain("Can&#x27;t publish yet: the registration support contact is missing.");
    expect(markup).toContain("Go to Registration support contact");
    expect(markup).toContain('id="event-field-support-contact"');
    expect(markup).toContain('aria-disabled="true"');
  });

  it("links to the registration builder when the form is the missing piece", () => {
    const markup = render({ publishedFormCount: 0 });
    expect(markup).toContain("a published registration form is missing");
    expect(markup).toContain('href="/registration-builder?event=event-1"');
  });

  it("offers Publish with no blocker once everything is ready", () => {
    const markup = render();
    expect(markup).not.toContain("Can&#x27;t publish yet");
    expect(markup).toContain("Every checklist item is complete");
    expect(markup).toContain('aria-disabled="false"');
  });

  it("ties the blocker text to the Publish button and keeps one live region per area", () => {
    const markup = render({ supportContact: null });
    expect(markup).toContain('id="event-publish-blocker"');
    expect(markup).toMatch(/<button[^>]*aria-describedby="event-publish-blocker"[^>]*>Publish event/);
    expect(markup).not.toMatch(/class="event-publish-blocker"[^>]*role=/);
    expect(markup).not.toMatch(/class="event-savebar-status"[\s\S]{0,300}role="(status|alert)"/);
  });
});
