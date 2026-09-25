import type { PublicClubListing } from "@/modules/organizations/public-club-directory";

/**
 * Pure helpers for the public club map (#437), kept apart from the Leaflet
 * component so they can be tested without a browser.
 *
 * Club and church names are free text typed by club directors, and Leaflet
 * writes any *string* it is handed for a tooltip, popup, divIcon, or
 * attribution straight into `innerHTML`. So the map never hands Leaflet a
 * string: everything it shows is built here as DOM nodes whose text is set
 * with `textContent`, which the browser never parses as markup.
 */

export type ClubMapGroup = {
  /** Stable key for the church's point: its coordinates. */
  key: string;
  latitude: number;
  longitude: number;
  /** Every listed club that meets at this point, in list order. */
  clubs: PublicClubListing[];
};

export function locationKey(latitude: number, longitude: number) {
  return `${latitude},${longitude}`;
}

/**
 * Clubs sponsored by the same church sit at the same coordinates; one pin
 * per point keeps them from stacking invisibly on top of each other.
 */
export function groupClubsByLocation(clubs: PublicClubListing[]): ClubMapGroup[] {
  const groups = new Map<string, ClubMapGroup>();
  for (const club of clubs) {
    if (club.latitude === null || club.longitude === null) continue;
    const key = locationKey(club.latitude, club.longitude);
    const group = groups.get(key);
    if (group) {
      group.clubs.push(club);
    } else {
      groups.set(key, { key, latitude: club.latitude, longitude: club.longitude, clubs: [club] });
    }
  }
  return [...groups.values()];
}

/** Which clubs a pin holds; a pin is rebuilt only when this changes. */
export function groupSignature(group: ClubMapGroup) {
  return group.clubs.map((club) => club.id).join(",");
}

function churchNames(group: ClubMapGroup) {
  return [...new Set(group.clubs.map((club) => club.churchName).filter(Boolean))];
}

/** Plain-text accessible name for a pin (set with setAttribute, never parsed). */
export function markerLabel(group: ClubMapGroup) {
  const names = group.clubs.map((club) => club.clubName).join(", ");
  const churches = churchNames(group).join(", ");
  const place = [churches, group.clubs[0]?.town].filter(Boolean).join(", ");
  const count = group.clubs.length === 1 ? names : `${group.clubs.length} clubs: ${names}`;
  return place ? `${count} — ${place}` : count;
}

/**
 * The pin's tooltip: the church, then every club that meets there. Built
 * from nodes and `textContent` only, so a name like
 * `<img src=x onerror=alert(1)>` shows as those literal characters.
 */
export function buildTooltipContent(doc: Document, group: ClubMapGroup): HTMLElement {
  const root = doc.createElement("div");
  root.className = "club-map-tooltip";

  const churches = churchNames(group);
  if (churches.length > 0) {
    const heading = doc.createElement("strong");
    heading.textContent = churches.join(", ");
    root.appendChild(heading);
  }

  const list = doc.createElement("ul");
  for (const club of group.clubs) {
    const item = doc.createElement("li");
    item.textContent = club.clubName;
    list.appendChild(item);
  }
  root.appendChild(list);
  return root;
}
