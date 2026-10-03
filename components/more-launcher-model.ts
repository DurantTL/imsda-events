import {
  moreDirectoryGroupLabels,
  moreDirectoryGroupOrder,
  type MoreDirectoryCard,
  type MoreDirectoryGroup,
} from "@/components/staff-navigation";

/**
 * The More launcher's pure rules (#741 slice 2): which cards it lists, how they
 * group, the footer links, arrow-key movement, and where focus goes on close.
 * Kept free of React so each rule is testable on its own. The launcher only
 * lists destinations; every page and route keeps its own authorization.
 */

export type LauncherGroup = { group: MoreDirectoryGroup; label: string; cards: readonly MoreDirectoryCard[] };

/** Allowed cards only, in the directory's group order. A group with no allowed card is left out. */
export function launcherGroups(cards: readonly MoreDirectoryCard[]): LauncherGroup[] {
  return moreDirectoryGroupOrder
    .map((group) => ({
      group,
      label: moreDirectoryGroupLabels[group],
      cards: cards.filter((card) => card.allowed && card.group === group),
    }))
    .filter((entry) => entry.cards.length > 0);
}

/**
 * Module requests exist (#741 slice 3): Event Admins get a "Request a feature"
 * link. The flag stays so a deployment-wide switch-off is one line.
 */
export const moduleRequestsEnabled = true;

export type LauncherFooterLink = { key: "manage-modules" | "event-modules" | "request-feature"; label: string; href: string };

/**
 * Everyone gets a link to the Event modules page, which also holds the audit
 * trail: system administrators as "Manage event modules", everyone else as "Event
 * modules and activity". Event staff also get "Request a feature" when requests
 * exist and the viewer may make one; with the flag off nobody does. Only Event Admins (`CONFIGURE_EVENT`) who are not system administrators can.
 */
export function launcherFooterLinks({
  isSystemAdmin,
  canRequestFeature = false,
  requestsEnabled = moduleRequestsEnabled,
  eventQuery,
}: {
  isSystemAdmin: boolean;
  canRequestFeature?: boolean;
  requestsEnabled?: boolean;
  eventQuery: string;
}): LauncherFooterLink[] {
  if (isSystemAdmin) return [{ key: "manage-modules", label: "Manage event modules", href: `/more${eventQuery}` }];
  const links: LauncherFooterLink[] = [{ key: "event-modules", label: "Event modules and activity", href: `/more${eventQuery}` }];
  if (requestsEnabled && canRequestFeature) {
    links.push({ key: "request-feature", label: "Request a feature", href: `/more${eventQuery}#request-a-feature` });
  }
  return links;
}

/**
 * Arrow-key movement through the launcher's links in reading order (the two
 * columns read top to bottom, then across, so the DOM order is the visual
 * order). Wraps at both ends; Home and End jump. `null` means the key is not one
 * the launcher handles.
 */
export function nextLauncherIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
    case "ArrowLeft":
      return current <= 0 ? count - 1 : current - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export type LauncherCloseReason = "escape" | "toggle" | "outside" | "navigate";

/**
 * Whether closing the launcher puts focus back on its trigger. Escape and the
 * trigger itself do. A click elsewhere, following a link, or tabbing out leaves
 * focus where the person put it, so the launcher never pulls it back.
 */
export function returnsFocusToTrigger(reason: LauncherCloseReason): boolean {
  return reason === "escape" || reason === "toggle";
}

/** Plain left-clicks open the launcher; a modified click (new tab, new window) keeps the link's normal behavior. */
export function isPlainClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * The width at which the phone tab bar and sheet give way to the sidebar and
 * popover. Matches the stylesheet's `@media (max-width: 800px)` phone block: the
 * sheet closes when this starts matching.
 */
export const phoneMaxWidthPx = 800;
export const desktopBreakpointQuery = `(min-width: ${phoneMaxWidthPx + 1}px)`;
