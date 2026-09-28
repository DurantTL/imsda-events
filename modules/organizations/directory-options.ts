import "server-only";

import { getPrisma } from "@/lib/prisma";

/**
 * The live club/church directory a registration form can source choices from
 * (#482): names only, for active organizations — never contact details,
 * addresses, or any other club's private data. Used to hydrate a form field
 * declared with `optionSource: "CLUBS_DIRECTORY" | "CHURCHES_DIRECTORY"`
 * (see `modules/forms/directory-form-options.ts`) at read and submit time,
 * so a rename or deactivation reaches every form immediately without a
 * republish.
 */
export type OrganizationDirectory = {
  clubs: string[];
  churches: string[];
};

export async function listClubDirectoryNames(): Promise<string[]> {
  const clubs = await getPrisma().organization.findMany({
    where: { type: "CLUB", isActive: true },
    orderBy: { name: "asc" },
    select: { name: true },
  });
  return clubs.map((club) => club.name);
}

export async function listChurchDirectoryNames(): Promise<string[]> {
  const churches = await getPrisma().organization.findMany({
    where: { type: "CHURCH", isActive: true },
    orderBy: { name: "asc" },
    select: { name: true },
  });
  return churches.map((church) => church.name);
}

export async function getOrganizationDirectory(): Promise<OrganizationDirectory> {
  const [clubs, churches] = await Promise.all([
    listClubDirectoryNames(),
    listChurchDirectoryNames(),
  ]);
  return { clubs, churches };
}
