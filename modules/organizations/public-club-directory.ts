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
  return clubs.map((club) => ({
    id: club.id,
    clubName: club.name,
    churchName: club.parentOrganization?.name ?? "",
    town: club.parentOrganization?.churchLocation?.city ?? "",
    state: club.parentOrganization?.churchLocation?.state ?? "",
    zip: club.parentOrganization?.churchLocation?.zip ?? "",
    meetingSchedule: club.clubProfile?.meetingSchedule ?? "",
    latitude: club.parentOrganization?.churchLocation?.latitude ?? null,
    longitude: club.parentOrganization?.churchLocation?.longitude ?? null,
  }));
}
