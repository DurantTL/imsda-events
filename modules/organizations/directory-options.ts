import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { normalizeOrganizationName } from "@/modules/organizations/domain";

/**
 * The live club/church directory a registration form can source choices from
 * (#482): names only, for active organizations — never contact details,
 * addresses, or any other club's private data. Used to hydrate a form field
 * declared with `optionSource: "CLUBS_DIRECTORY" | "CHURCHES_DIRECTORY"`
 * (see `modules/forms/form-options-repository.ts`) at read and submit time,
 * so a rename or deactivation reaches every form immediately without a
 * republish.
 *
 * Privacy: these names are treated as public. They are shown to anyone who
 * can open a published registration form, signed in or not — exactly what
 * the static club and church lists in the form templates showed before
 * this change. Nothing beyond the organization's display name is read or
 * returned here; keep it that way.
 */
export type OrganizationDirectory = {
  clubs: string[];
  churches: string[];
};

/** Anything that can read organizations: the app client or a transaction. */
export type DirectoryReadClient = Pick<Prisma.TransactionClient, "organization">;

/**
 * Active organization names of one type, one entry per normalized name.
 * Ordered by name, then id, so when two records share a normalized name the
 * same one always wins and the option list (and its React keys) stays stable
 * between reads.
 */
async function listDirectoryNames(client: DirectoryReadClient, type: "CLUB" | "CHURCH"): Promise<string[]> {
  const organizations = await client.organization.findMany({
    where: { type, isActive: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { name: true, normalizedName: true },
  });
  const seen = new Set<string>();
  const names: string[] = [];
  for (const organization of organizations) {
    const name = organization.name.trim();
    const key = organization.normalizedName || normalizeOrganizationName(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function listClubDirectoryNames(client: DirectoryReadClient = getPrisma()): Promise<string[]> {
  return listDirectoryNames(client, "CLUB");
}

export function listChurchDirectoryNames(client: DirectoryReadClient = getPrisma()): Promise<string[]> {
  return listDirectoryNames(client, "CHURCH");
}

export async function getOrganizationDirectory(client: DirectoryReadClient = getPrisma()): Promise<OrganizationDirectory> {
  const [clubs, churches] = await Promise.all([
    listClubDirectoryNames(client),
    listChurchDirectoryNames(client),
  ]);
  return { clubs, churches };
}
