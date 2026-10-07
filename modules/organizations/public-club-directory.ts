import "server-only";

import { getPrisma } from "@/lib/prisma";

/**
 * The public club directory (#437): only what a club chose to publish, for
 * anyone with no sign-in. A club appears only when its own director set
 * "list this club publicly" (ClubProfile.listPublicly) and the club and its
 * sponsoring church are both active. The `select` below is the entire
 * contract — church name, club name, town, and meeting day/time, plus the
 * town's map coordinates when staff entered them. It never reads contact
 * email, contact phone, the public description, the meeting place, or any
 * person's name; those columns are not even fetched, so there is nothing to
 * leak later by accident.
 */
const publicClubSelect = {
  id: true,
  name: true,
  clubProfile: { select: { meetingSchedule: true } },
  parentOrganization: {
    select: {
      name: true,
      type: true,
      // A company or group (#822) has no church location; its own city, state and
      // ZIP from the eAdventist record stand in. Never the street address.
      city: true,
      state: true,
      postalCode: true,
      churchLocation: {
        select: { city: true, state: true, zip: true, latitude: true, longitude: true },
      },
    },
  },
} as const;

export type PublicClubListing = {
  id: string;
  clubName: string;
  churchName: string;
  town: string;
  state: string;
  zip: string;
  meetingSchedule: string;
  latitude: number | null;
  longitude: number | null;
};

export async function listPublicClubs(): Promise<PublicClubListing[]> {
  const clubs = await getPrisma().organization.findMany({
    where: {
      type: "CLUB",
      isActive: true,
      clubProfile: { listPublicly: true },
      parentOrganization: { isActive: true },
    },
    orderBy: [{ name: "asc" }],
    select: publicClubSelect,
  });
  return clubs.map((club) => {
    const sponsor = club.parentOrganization;
    const location = sponsor?.churchLocation ?? null;
    // Only a company or group falls back to its own town; a church keeps the existing church-location path.
    const ownTown = !location && sponsor && sponsor.type !== "CHURCH" ? sponsor : null;
    return {
      id: club.id,
      clubName: club.name,
      churchName: sponsor?.name ?? "",
      town: location?.city ?? ownTown?.city ?? "",
      state: location?.state ?? ownTown?.state ?? "",
      zip: location?.zip ?? ownTown?.postalCode ?? "",
      meetingSchedule: club.clubProfile?.meetingSchedule ?? "",
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
    };
  });
}
