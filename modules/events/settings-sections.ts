/**
 * One source of truth (#624) for which event settings sections, "Settings &
 * activity" directory cards, and activity entries apply to club events, to
 * general (self-pay) events, or to both.
 *
 * "Club" means an event whose audience is CLUB (church-billed group events
 * such as Spring Camporee); "general" is every other event. Nothing here is
 * ever removed: a section that does not apply to the event's type is only
 * moved under a collapsed "More settings" disclosure, and a section that holds
 * a non-default value stays in view (`resolveSectionPlacement`).
 *
 * The rule for each entry is what the code does with the setting, noted next
 * to it.
 */

export type EventKind = "club" | "general";
export type AppliesTo = "both" | EventKind;

export function eventKindFromAudience(audience: string | null | undefined): EventKind {
  return audience === "CLUB" ? "club" : "general";
}

export function appliesToKind(appliesTo: AppliesTo, kind: EventKind): boolean {
  return appliesTo === "both" || appliesTo === kind;
}

/** Sections of the event settings form and its side column. */
export const eventSettingsSections = {
  // Name, dates, location, overall limit: every event has them.
  basics: "both",
  // Open/close dates and the waitlist: club registration reads both.
  "registration-timing": "both",
  // Audience and billing mode decide what every other section does.
  "audience-billing": "both",
  // Emailed-code verification guards individual registrants' private pages;
  // club directors edit through the club portal.
  "attendee-edit-policy": "general",
  // Only used in unpaid-balance messages for attendee-pay events; church
  // billing never creates an attendee balance.
  "payment-instructions": "general",
  // Ranked seminar preferences belong to individual attendees.
  "seminar-preferences": "general",
  // Registrants pick a shirt size on their own private page.
  "shirt-sizes": "general",
  // Youth-event flag for club staff and adults on a club roster.
  "adult-background-checks": "club",
  // Public page link and support contact: shown for every event.
  "public-information": "both",
  // Hotel tokens appear in individual registration messages only.
  lodging: "general",
  // Readiness, publishing, sharing, delete, and save are never hidden.
  readiness: "both",
  sharing: "both",
  "danger-zone": "both",
  save: "both",
  locations: "both",
} as const satisfies Record<string, AppliesTo>;

export type EventSettingsSectionId = keyof typeof eventSettingsSections;

/** The settings-form values each hideable section owns, with their defaults. */
type SettingsValues = {
  attendeeEditPolicy?: string | null;
  approvedPaymentInstructions?: string | null;
  seminarPreferenceClosesOn?: string | null;
  seminarPreferenceSelfServiceLocked?: boolean | null;
  collectsShirtSizes?: boolean | null;
  checksAdultBackgrounds?: boolean | null;
  hotelName?: string | null;
  hotelBookingUrl?: string | null;
  hotelPhone?: string | null;
  hotelGroupName?: string | null;
  hotelRate?: string | null;
  hotelInstructions?: string | null;
};

const filled = (value: string | null | undefined) => Boolean(value && value.trim());

/** Sections whose stored value differs from the default, so they never hide. */
export function sectionsWithNonDefaultValues(values: SettingsValues): Set<EventSettingsSectionId> {
  const set = new Set<EventSettingsSectionId>();
  if (values.attendeeEditPolicy && values.attendeeEditPolicy !== "VERIFY_EVERY_EDIT") set.add("attendee-edit-policy");
  if (filled(values.approvedPaymentInstructions)) set.add("payment-instructions");
  if (filled(values.seminarPreferenceClosesOn) || values.seminarPreferenceSelfServiceLocked) set.add("seminar-preferences");
  if (values.collectsShirtSizes) set.add("shirt-sizes");
  if (values.checksAdultBackgrounds) set.add("adult-background-checks");
  if ([
    values.hotelName,
    values.hotelBookingUrl,
    values.hotelPhone,
    values.hotelGroupName,
    values.hotelRate,
    values.hotelInstructions,
  ].some(filled)) set.add("lodging");
  return set;
}

export type SectionPlacement = "primary" | "more";

/** Where a section renders for this event kind: in view, or under "More settings". */
export function resolveSectionPlacement(
  id: EventSettingsSectionId,
  kind: EventKind,
  nonDefault: ReadonlySet<EventSettingsSectionId>,
): SectionPlacement {
  return appliesToKind(eventSettingsSections[id], kind) || nonDefault.has(id) ? "primary" : "more";
}

/** "Settings & activity" directory cards (`buildMoreDirectoryCards` keys). */
export const moreDirectoryCardApplicability: Record<string, AppliesTo> = {
  "event-settings": "both",
  "attendee-configuration": "both",
  tags: "both",
  // Honors classes, seminar assignments, merchandise, and promo codes are not
  // read by club registration (`modules/club-registrations`).
  honors: "general",
  "program-assignments": "general",
  merchandise: "general",
  "promo-codes": "general",
  "registration-builder": "both",
  "event-content": "both",
  community: "both",
  staff: "both",
  "clubs-and-churches": "club",
  clubs: "club",
  "club-assignments": "club",
  "event-patches": "club",
  "club-forms": "both",
  imports: "both",
  reports: "both",
  health: "both",
};

/** Unlisted cards stay visible: a new card is never hidden by accident. */
export function moreCardApplies(key: string, kind: EventKind): boolean {
  return appliesToKind(moreDirectoryCardApplicability[key] ?? "both", kind);
}

/** Panels on the "Settings & activity" page, most used first. */
export const activityPagePanels = [
  { id: "tasks", appliesTo: "both", collapsed: false },
  { id: "recent-activity", appliesTo: "both", collapsed: false },
  { id: "more-settings", appliesTo: "both", collapsed: true },
  { id: "sign-in-settings", appliesTo: "both", collapsed: true },
  { id: "sessions", appliesTo: "both", collapsed: true },
] as const satisfies ReadonlyArray<{ id: string; appliesTo: AppliesTo; collapsed: boolean }>;

const generalOnlyActionPrefixes = [
  "PROMO_CODE",
  "SHIRT_SIZE",
  "PUBLIC_ATTENDEE",
  "PUBLIC_REGISTRATION",
  "PRIVATE_LINK",
  "PROGRAM_ASSIGNMENTS",
  "REGISTRATION_ACCESS_",
  "REGISTRATION_CARD_SURCHARGE",
  "SQUARE_",
  "BALANCE_REMINDER",
] as const;
const clubOnlyActionPrefixes = ["CLUB_"] as const;

/** Which event type an audit action belongs to; unknown actions apply to both. */
export function activityActionAppliesTo(action: string): AppliesTo {
  if (clubOnlyActionPrefixes.some((prefix) => action.startsWith(prefix))) return "club";
  if (generalOnlyActionPrefixes.some((prefix) => action.startsWith(prefix))) return "general";
  return "both";
}

export function filterActivityForKind<T extends { action: string }>(entries: readonly T[], kind: EventKind): T[] {
  return entries.filter((entry) => appliesToKind(activityActionAppliesTo(entry.action), kind));
}
