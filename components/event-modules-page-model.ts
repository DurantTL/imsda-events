import {
  moreDirectoryGroupOrder,
  type MoreDirectoryCard,
  type MoreDirectoryGroup,
} from "@/components/staff-navigation";
import {
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

export type EnabledModuleEntry = { definition: EventModuleDefinition; card: MoreDirectoryCard };

export type EventModulesView = {
  enabled: EnabledModuleEntry[];
  /** Modules that are off, for a system administrator only; always empty for anyone else. */
  disabled: EventModuleDefinition[];
  /** Allowed staff tools that belong to no module. */
  tools: MoreDirectoryCard[];
  canToggle: boolean;
};

export function buildEventModulesView({
  cards,
  enabled,
  isSystemAdmin,
}: {
  /** Every More card with its permission result, with no module hiding applied. */
  cards: readonly MoreDirectoryCard[];
  enabled: ReadonlySet<EventModuleKey>;
  isSystemAdmin: boolean;
}): EventModulesView {
  const moduleCardKeys = new Set(eventModuleCatalog.map((definition) => definition.cardKey));
  const enabledEntries: EnabledModuleEntry[] = [];
  for (const definition of eventModuleCatalog) {
    if (!enabled.has(definition.key)) continue;
    const card = cards.find((candidate) => candidate.key === definition.cardKey && candidate.allowed);
    if (card) enabledEntries.push({ definition, card });
  }
  return {
    enabled: enabledEntries,
    disabled: isSystemAdmin ? eventModuleCatalog.filter((definition) => !enabled.has(definition.key)) : [],
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
