import {
  moreDirectoryGroupOrder,
  type MoreDirectoryCard,
  type MoreDirectoryGroup,
} from "@/components/staff-navigation";
import {
  canEnableForEvent,
  dataDrivenReasons,
  eventModuleCatalog,
  type EventModuleApplicability,
  type EventModuleDefinition,
  type EventModuleKey,
} from "@/modules/event-modules/catalog";

/**
 * What the Event modules page (`/more`, #741 slice 2) shows each kind of viewer.
 * Pure, so the visibility rules are testable without rendering the page.
 *
 * - Enabled modules show for anyone who may open the module's card (the card's
 *   own permission rule decides), so an event admin sees what is on.
 * - Modules that are off show only to a system administrator, who is the only
 *   role that can turn them on. Everyone else gets no disabled card and no
 *   Enable button.
 * - Ordinary staff tools are not modules; they are listed apart so a phone has
 *   them on this page as well as in the launcher.
 */

export type EnabledModuleEntry = {
  definition: EventModuleDefinition;
  card: MoreDirectoryCard;
  /** A system administrator may turn it off: it has a stored row, is not always on, and no data keeps it on. */
  canToggle: boolean;
  /** Set when it is on because of the event's data, with nothing to turn off. */
  dataReason?: string;
};

export type DisabledModuleEntry = {
  definition: EventModuleDefinition;
  /** False when the module does not apply to this event (a club module on a general event): no Enable. */
  canEnable: boolean;
};

export type EventModulesView = {
  enabled: EnabledModuleEntry[];
  /** Modules that are off, for a system administrator only; always empty for anyone else. */
  disabled: DisabledModuleEntry[];
  /**
   * Modules with a stored row that do not apply to this event any more (left over
   * from a club to general audience change), for a system administrator only, so
   * the row can always be turned off.
   */
  leftOver: EventModuleDefinition[];
  /** Allowed staff tools that belong to no module. */
  tools: MoreDirectoryCard[];
  canToggle: boolean;
};

export function buildEventModulesView({
  cards,
  stored,
  effective,
  dataPresent,
  dataForced,
  isSystemAdmin,
  audience,
}: {
  /** Every More card with its permission result, with no module hiding applied. */
  cards: readonly MoreDirectoryCard[];
  /** Always-on modules plus stored rows. */
  stored: ReadonlySet<EventModuleKey>;
  /** `stored` plus the modules the event's data needs (`moduleState`). */
  effective: ReadonlySet<EventModuleKey>;
  /** Modules the event has data for (`moduleState`): Honors applies to any event that has honors data. */
  dataPresent: ReadonlySet<EventModuleKey>;
  /** Data-driven modules kept on by their data: no Turn off. */
  dataForced: ReadonlySet<EventModuleKey>;
  isSystemAdmin: boolean;
  audience: "GENERAL" | "CLUB";
}): EventModulesView {
  const moduleCardKeys = new Set(eventModuleCatalog.map((definition) => definition.cardKey));
  const enabledEntries: EnabledModuleEntry[] = [];
  for (const definition of eventModuleCatalog) {
    if (!effective.has(definition.key)) continue;
    const card = cards.find((candidate) => candidate.key === definition.cardKey && candidate.allowed);
    if (!card) continue;
    const hasRow = stored.has(definition.key);
    enabledEntries.push({
      definition,
      card,
      canToggle: isSystemAdmin && !definition.alwaysOn && hasRow && !dataForced.has(definition.key),
      dataReason: dataForced.has(definition.key) || !hasRow ? dataDrivenReasons[definition.key] : undefined,
    });
  }
  return {
    enabled: enabledEntries,
    disabled: isSystemAdmin
      ? eventModuleCatalog
        .filter((definition) => !effective.has(definition.key))
        .map((definition) => ({ definition, canEnable: canEnableForEvent(definition.key, audience, dataPresent) }))
      : [],
    leftOver: isSystemAdmin
      ? eventModuleCatalog.filter((definition) => !definition.alwaysOn
        && stored.has(definition.key)
        && !canEnableForEvent(definition.key, audience, dataPresent)
        // Never twice: a module already in the enabled list can be turned off from there.
        && !enabledEntries.some((entry) => entry.definition.key === definition.key))
      : [],
    tools: cards.filter((card) => card.allowed && !moduleCardKeys.has(card.key)),
    canToggle: isSystemAdmin,
  };
}

/** Enabled modules grouped the way the launcher groups them. */
export function groupEnabledModules(entries: readonly EnabledModuleEntry[]): Array<{ group: MoreDirectoryGroup; entries: EnabledModuleEntry[] }> {
  return moreDirectoryGroupOrder
    .map((group) => ({ group, entries: entries.filter((entry) => entry.definition.launcherGroup === group) }))
    .filter((entry) => entry.entries.length > 0);
}

export const applicabilityLabels: Record<EventModuleApplicability, string> = {
  "club-audience": "Club events",
  "ranked-seminar": "Events with ranked seminar choices",
  any: "Any event",
};

/** The health strip's message: attention (with counts) or all clear. */
export function healthStripState(summary: { total: number; urgent: number; watch: number }): {
  state: "attention" | "clear";
  message: string;
} {
  if (summary.total === 0) return { state: "clear", message: "All clear. Nothing needs attention right now." };
  const parts = [summary.urgent > 0 ? `${summary.urgent} need action` : null, summary.watch > 0 ? `${summary.watch} to watch` : null].filter(Boolean);
  return {
    state: "attention",
    message: `${summary.total} ${summary.total === 1 ? "item needs" : "items need"} attention (${parts.join(", ")}).`,
  };
}

/**
 * The optional task search on the More page (#743): a card or tool matches when
 * every word typed appears in its name, ignoring case and extra spacing. A blank
 * search matches everything. Names only, so it can never reveal a card the
 * viewer was not already shown.
 */
export function taskNameMatches(name: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = name.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
