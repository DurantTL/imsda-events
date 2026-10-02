/**
 * The catalog of per-event modules (#741): which features an event can turn on,
 * who they apply to, and what they gate. Pure and database-free; the stored
 * "enabled" state is `EventModule` rows (`service.ts`).
 *
 * A module is a relevance switch, never an authorization rule. A route's own
 * permission check is unchanged whether or not its module is on.
 */

export const eventModuleKeys = [
  "honors",
  "event-patches",
  "club-assignments",
  "seminar-assignments",
  "merchandise",
  "attendee-community",
  "public-content",
] as const;

export type EventModuleKey = (typeof eventModuleKeys)[number];

/**
 * Who a module is for: club-audience events (#481), events with ranked
 * seminar preferences, or any event. "Applies" is a hint for showing a
 * module; it neither enables nor grants anything.
 */
export type EventModuleApplicability = "club-audience" | "ranked-seminar" | "any";

/** Launcher groups match the More directory groups. */
export type EventModuleLauncherGroup = "setup" | "content-sales" | "people-access" | "reports";

export type EventModuleDefinition = {
  key: EventModuleKey;
  title: string;
  description: string;
  appliesTo: EventModuleApplicability;
  launcherGroup: EventModuleLauncherGroup;
  /** On for every event with no stored row; cannot be turned off. */
  alwaysOn: boolean;
  /** Routes the module's entry points open. Listing a route here grants nothing. */
  routes: readonly string[];
  /** Named features that follow the module. */
  features: readonly string[];
};

export const eventModuleCatalog: readonly EventModuleDefinition[] = [
  {
    key: "honors",
    title: "Honors classes",
    description: "Name sessions and set the honor classes, seats, and age limits an Honors Weekend offers.",
    appliesTo: "club-audience",
    launcherGroup: "setup",
    alwaysOn: false,
    routes: ["/more/honors"],
    features: ["honors-builder"],
  },
  {
    key: "event-patches",
    title: "Event patches",
    description: "Link the patch or pin a club event gives, so directors are suggested it for every member who attended.",
    appliesTo: "club-audience",
    launcherGroup: "setup",
    alwaysOn: false,
    routes: ["/more/event-patches"],
    features: [],
  },
  {
    key: "club-assignments",
    title: "Club assignments",
    description: "Set each registered club's campsite, duty, and activity, then email directors after review.",
    appliesTo: "club-audience",
    launcherGroup: "people-access",
    alwaysOn: false,
    routes: ["/more/club-assignments"],
    features: [],
  },
  {
    key: "seminar-assignments",
    title: "Seminar assignments",
    description: "Turn attendee rankings and room limits into reviewed, printable session rosters.",
    appliesTo: "ranked-seminar",
    launcherGroup: "setup",
    alwaysOn: false,
    routes: ["/more/program-assignments"],
    features: [],
  },
  {
    key: "merchandise",
    title: "Merchandise",
    description: "Add products, set artwork and pricing, and control what is available at registration.",
    appliesTo: "any",
    launcherGroup: "content-sales",
    alwaysOn: false,
    routes: ["/more/merchandise"],
    features: ["registration-merchandise"],
  },
  {
    key: "attendee-community",
    title: "Attendee community",
    description: "Open or pause discussion, review attendee reports, and moderate posts and replies.",
    appliesTo: "any",
    launcherGroup: "content-sales",
    alwaysOn: false,
    routes: ["/community"],
    features: ["community-moderation"],
  },
  {
    key: "public-content",
    title: "Public content",
    description: "Speaker bios, seminar descriptions, lodging, schedules, and downloads shown publicly.",
    appliesTo: "any",
    launcherGroup: "content-sales",
    alwaysOn: true,
    routes: ["/more/event-content"],
    features: ["public-event-page"],
  },
];

const definitionsByKey = new Map<string, EventModuleDefinition>(
  eventModuleCatalog.map((definition) => [definition.key, definition]),
);

export function isEventModuleKey(value: unknown): value is EventModuleKey {
  return typeof value === "string" && definitionsByKey.has(value);
}

export function eventModuleDefinition(key: EventModuleKey): EventModuleDefinition {
  return definitionsByKey.get(key)!;
}

/** The facts an applicability rule reads. */
export type EventModuleContext = {
  audience: "GENERAL" | "CLUB";
  /** The event has a ranked-interest seminar field on a form, or has run an assignment. */
  hasRankedSeminars: boolean;
};

export function moduleApplies(key: EventModuleKey, context: EventModuleContext): boolean {
  switch (eventModuleDefinition(key).appliesTo) {
    case "any":
      return true;
    case "club-audience":
      return context.audience === "CLUB";
    case "ranked-seminar":
      return context.hasRankedSeminars;
  }
}

/**
 * Whether an entry point for a module shows: the module is on for the event
 * (data already there keeps working) or it applies to the event's type.
 */
export function moduleVisible(key: EventModuleKey, enabled: ReadonlySet<EventModuleKey>, context: EventModuleContext): boolean {
  return enabled.has(key) || moduleApplies(key, context);
}

/** Modules whose events have club-form work to do. */
const clubFormsModules: readonly EventModuleKey[] = ["honors", "event-patches", "club-assignments"];

/**
 * Club forms (#610) belong to no event, so they are not a module. Their entry
 * point is available on a club-audience event, or on any event where a club
 * module is enabled. #721's per-form roster setting is unaffected.
 */
export function clubFormsAvailable(enabled: ReadonlySet<EventModuleKey>, context: Pick<EventModuleContext, "audience">): boolean {
  return context.audience === "CLUB" || clubFormsModules.some((key) => enabled.has(key));
}
