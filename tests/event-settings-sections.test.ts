import { describe, expect, it } from "vitest";
import {
  activityActionAppliesTo,
  appliesToKind,
  eventKindFromAudience,
  eventSettingsSections,
  filterActivityForKind,
  moreCardApplies,
  resolveSectionPlacement,
  sectionsWithNonDefaultValues,
  type EventSettingsSectionId,
} from "@/modules/events/settings-sections";

const none = new Set<EventSettingsSectionId>();

describe("event settings sections by event type (#624)", () => {
  it("maps the audience to an event kind", () => {
    expect(eventKindFromAudience("CLUB")).toBe("club");
    expect(eventKindFromAudience("GENERAL")).toBe("general");
    expect(eventKindFromAudience(undefined)).toBe("general");
  });

  it("puts each section in view for the types it applies to and under More settings for the rest", () => {
    const placement = (id: EventSettingsSectionId, kind: "club" | "general") => resolveSectionPlacement(id, kind, none);
    for (const id of ["basics", "registration-timing", "audience-billing", "public-information", "locations"] as const) {
      expect(placement(id, "club")).toBe("primary");
      expect(placement(id, "general")).toBe("primary");
    }
    for (const id of ["attendee-edit-policy", "payment-instructions", "seminar-preferences", "shirt-sizes", "lodging"] as const) {
      expect(placement(id, "general")).toBe("primary");
      expect(placement(id, "club")).toBe("more");
    }
    expect(placement("adult-background-checks", "club")).toBe("primary");
    expect(placement("adult-background-checks", "general")).toBe("more");
  });

  it("never hides the publish, sharing, delete, or save sections for any type", () => {
    for (const id of ["readiness", "sharing", "danger-zone", "save"] as const) {
      expect(eventSettingsSections[id]).toBe("both");
    }
  });

  it("keeps a hidden section in view when it holds a non-default value", () => {
    const nonDefault = sectionsWithNonDefaultValues({ hotelName: "Synthetic Inn", collectsShirtSizes: true });
    expect(resolveSectionPlacement("lodging", "club", nonDefault)).toBe("primary");
    expect(resolveSectionPlacement("shirt-sizes", "club", nonDefault)).toBe("primary");
    expect(resolveSectionPlacement("seminar-preferences", "club", nonDefault)).toBe("more");
    expect(resolveSectionPlacement("adult-background-checks", "general", sectionsWithNonDefaultValues({ checksAdultBackgrounds: true }))).toBe("primary");
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
    expect(sectionsWithNonDefaultValues({ approvedPaymentInstructions: "Pay by check." }).has("payment-instructions")).toBe(true);
    expect(sectionsWithNonDefaultValues({ seminarPreferenceClosesOn: "2027-01-05" }).has("seminar-preferences")).toBe(true);
  });

  it("collapses directory cards that do not apply and keeps unknown cards visible", () => {
    expect(moreCardApplies("honors", "club")).toBe(true);
    expect(moreCardApplies("honors", "general")).toBe(true);
    expect(moreCardApplies("promo-codes", "club")).toBe(false);
    expect(moreCardApplies("promo-codes", "general")).toBe(true);
    expect(moreCardApplies("event-patches", "general")).toBe(false);
    expect(moreCardApplies("event-patches", "club")).toBe(true);
    expect(moreCardApplies("event-settings", "club")).toBe(true);
    expect(moreCardApplies("brand-new-card", "club")).toBe(true);
  });

  it("filters activity to the event type", () => {
    expect(activityActionAppliesTo("CLUB_ORDER_MARKED_ALREADY_AWARDED")).toBe("club");
    expect(activityActionAppliesTo("PROMO_CODE_CREATED")).toBe("general");
    expect(activityActionAppliesTo("REGISTRATION_CREATED")).toBe("both");
    const entries = [{ action: "CLUB_ASSIGNMENTS_BATCH_ENQUEUED" }, { action: "PROMO_CODE_CREATED" }, { action: "TAG_CREATED" }];
    expect(filterActivityForKind(entries, "club").map((e) => e.action)).toEqual(["CLUB_ASSIGNMENTS_BATCH_ENQUEUED", "TAG_CREATED"]);
    expect(filterActivityForKind(entries, "general").map((e) => e.action)).toEqual(["PROMO_CODE_CREATED", "TAG_CREATED"]);
    expect(appliesToKind("both", "club")).toBe(true);
  });
});
