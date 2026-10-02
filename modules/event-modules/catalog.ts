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
  /** The More directory card (`buildMoreDirectoryCards`) this module owns. */
  cardKey: string;
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
    cardKey: "honors",
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
    cardKey: "event-patches",
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
    cardKey: "club-assignments",
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
    cardKey: "program-assignments",
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
    cardKey: "merchandise",
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
    cardKey: "community",
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
    cardKey: "event-content",
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

/**
 * The facts an applicability rule reads. Only `audience` is needed for the
 * club modules; `hasRankedSeminars` is for the seminar rule and is left out
 * wherever that module is not checked.
 */
export type EventModuleContext = {
  audience: "GENERAL" | "CLUB";
  /** The event has a ranked-interest seminar field on a form, or has run an assignment. */
  hasRankedSeminars?: boolean;
};

export function moduleApplies(key: EventModuleKey, context: EventModuleContext): boolean {
  switch (eventModuleDefinition(key).appliesTo) {
    case "any":
      return true;
    case "club-audience":
      return context.audience === "CLUB";
    case "ranked-seminar":
      return context.hasRankedSeminars === true;
  }
}

/**
 * The modules a new event starts with: public content for every event, and the
 * club modules for a club-audience event. Everything else is off until a
 * system administrator turns it on.
 */
export function defaultModuleKeys(audience: "GENERAL" | "CLUB"): EventModuleKey[] {
  return eventModuleCatalog
    .filter((entry) => entry.alwaysOn || (entry.appliesTo === "club-audience" && audience === "CLUB"))
    .map((entry) => entry.key);
}

/**
 * Visibility reads stored rows only (#741): a module that is off is hidden even
 * where it applies, so turning it off, and its audit entry, mean what they say.
 * New events get their rows at creation (`defaults.ts`). Returns the More card
 * keys of the given modules that are off for the event.
 */
export function hiddenModuleCardKeys(enabled: ReadonlySet<EventModuleKey>, gated: readonly EventModuleKey[]): Set<string> {
  return new Set(gated.filter((key) => !enabled.has(key)).map((key) => eventModuleDefinition(key).cardKey));
}
