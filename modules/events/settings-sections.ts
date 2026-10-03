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
/**
 * "attendee-pay" is billing-based, not audience-based: the section only has an
 * effect when attendees pay online (billing mode ATTENDEE_PAY). Choice (#624
 * review): payment instructions are read only for attendee-pay events
 * (`messaging-repository`), so church billing hides them whatever the audience.
 */
export type AppliesTo = "both" | EventKind | "attendee-pay";

/** What decides whether a section applies: the audience and the billing mode. */
export type EventTypeContext = {
  kind: EventKind;
  billingMode?: string | null;
};

export function appliesToContext(appliesTo: AppliesTo, context: EventTypeContext): boolean {
  if (appliesTo === "both") return true;
  if (appliesTo === "attendee-pay") return context.billingMode !== "DEFERRED_ORGANIZATION_INVOICE";
  return appliesTo === context.kind;
}

export function eventKindFromAudience(audience: string | null | undefined): EventKind {
  return audience === "CLUB" ? "club" : "general";
}

/** Audience-only check, for cards and activity, which do not depend on billing. */
export function appliesToKind(appliesTo: AppliesTo, kind: EventKind): boolean {
  return appliesToContext(appliesTo, { kind });
}

/** Sections of the event settings form and its side column. */
export const eventSettingsSections = {
  // Name, dates, location, overall limit: every event has them.
  basics: "both",
  // Open/close dates and the waitlist: club registration reads both.
  "registration-timing": "both",
  // Audience and billing mode decide what every other section does.
  "audience-billing": "both",
  // Emailed-code verification guards every registrant's private page, club
  // registrants' included (`attendee-accounts`).
  "attendee-edit-policy": "both",
  // Read only for attendee-pay events (`messaging-repository`), so it follows
  // the billing mode, not the audience.
  "payment-instructions": "attendee-pay",
  // Ranked seminar preferences belong to individual attendees.
  "seminar-preferences": "general",
  // Club registrants have private pages that read the shirt-size setting.
  "shirt-sizes": "both",
  // Applies to every event that registers adults, general youth events too.
  "adult-background-checks": "both",
  // Public page link and support contact: shown for every event.
  "public-information": "both",
  // Club registrations get `hotel_information` in their messages too.
  lodging: "both",
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
  context: EventTypeContext,
  nonDefault: ReadonlySet<EventSettingsSectionId>,
): SectionPlacement {
  return appliesToContext(eventSettingsSections[id], context) || nonDefault.has(id) ? "primary" : "more";
}

/** "Settings & activity" directory cards (`buildMoreDirectoryCards` keys). */
export const moreDirectoryCardApplicability: Record<string, AppliesTo> = {
  "event-settings": "both",
  "attendee-configuration": "both",
  tags: "both",
  // Honors is an event module (#741): the module row decides whether the card
  // shows (system admins find it under "More settings" when it is off), so this
  // audience entry stays "both". Seminar assignments, merchandise, and promo
  // codes are not read by club registration (`modules/club-registrations`).
  honors: "both",
  "program-assignments": "general",
  merchandise: "general",
  "promo-codes": "both",
  payments: "both",
  "registration-builder": "both",
  "event-content": "both",
  community: "both",
  staff: "both",
  "clubs-and-churches": "club",
  clubs: "club",
  "club-assignments": "club",
  "event-patches": "club",
  "club-forms": "both",
  "event-health": "club",
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

/**
 * Activity is filtered by an allowlist of low-risk configuration noise only
 * (#624 review): each prefix below is hidden on the other event type. Anything
 * not listed always shows.
 */
const generalOnlyNoisePrefixes = [
  "PROMO_CODE_",
  "SHIRT_SIZE_REQUEST",
  "BALANCE_REMINDER_BATCH",
] as const;
const clubOnlyNoisePrefixes = ["CLUB_ASSIGNMENTS_BATCH"] as const;

/**
 * Never filtered, whatever the type: refunds and payments, registration
 * access and private links, public registration and attendee actions, deletes,
 * staff and permission changes, and background checks. Checked before the
 * allowlist so a future prefix can't hide them.
 */
const neverFilteredPattern =
  /SQUARE|REFUND|PAYMENT|CARD_SURCHARGE|ADJUSTMENT|REGISTRATION_ACCESS|PRIVATE_LINK|PUBLIC_|ATTENDEE|DELETE|STAFF|PERMISSION|MEMBERSHIP|ROLE|BACKGROUND/;

/** Which event type an audit action belongs to; unlisted actions apply to both. */
export function activityActionAppliesTo(action: string): AppliesTo {
  if (neverFilteredPattern.test(action)) return "both";
  if (clubOnlyNoisePrefixes.some((prefix) => action.startsWith(prefix))) return "club";
  if (generalOnlyNoisePrefixes.some((prefix) => action.startsWith(prefix))) return "general";
  return "both";
}

export function filterActivityForKind<T extends { action: string }>(entries: readonly T[], kind: EventKind): T[] {
  return entries.filter((entry) => appliesToKind(activityActionAppliesTo(entry.action), kind));
}

export type ActivitySelection<T> = {
  entries: T[];
  /** True when entries were hidden for the event type (counted before any slice). */
  filtered: boolean;
  /** True when there were entries but every one was for the other event type. */
  allFilteredOut: boolean;
};

/** The recent-activity list for one event type; `showAll` bypasses the filter. */
export function selectActivity<T extends { action: string }>(
  all: readonly T[],
  kind: EventKind,
  showAll: boolean,
  limit = 12,
): ActivitySelection<T> {
  const matching = showAll ? [...all] : filterActivityForKind(all, kind);
  const filtered = !showAll && matching.length < all.length;
  return {
    entries: matching.slice(0, limit),
    filtered,
    allFilteredOut: filtered && matching.length === 0,
  };
}
