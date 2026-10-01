import type { Prisma } from "@prisma/client";

/**
 * Server-side organization search (#723), shared by the Clubs and churches
 * page and the organization directory. Pure and free of database access so the
 * matching rules are unit-testable.
 *
 * The query is NFKC-normalised (as names are stored) and split on whitespace. Every word has to match at least one
 * searchable field (case-insensitive "contains"), so "albia school" finds the
 * school in Albia whichever fields hold the two words. Accents are not folded:
 * Postgres would need the unaccent extension, which this database does not
 * install.
 */

export const ORGANIZATION_SEARCH_MAX_LENGTH = 80;
const MAX_TERMS = 6;

/** The query as kept in the URL and the search box: a length cap only. */
export function cleanSearchQuery(value: string | null | undefined) {
  return (value ?? "").slice(0, ORGANIZATION_SEARCH_MAX_LENGTH);
}

export function searchTerms(query: string) {
  return cleanSearchQuery(query).normalize("NFKC").trim().split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
}

function termMatches(term: string): Prisma.OrganizationWhereInput {
  const contains = { contains: term, mode: "insensitive" as const };
  return {
    OR: [
      { name: contains },
      { city: contains },
      // "Albia IA": a state abbreviation is matched whole, not as a substring.
      { state: { equals: term, mode: "insensitive" } },
      { orgCode: contains },
      { eadventistId: contains },
      { externalIdentities: { some: { externalId: contains } } },
      { district: contains },
      // A club's sponsoring church, and a directory record's parent organization.
      { parentOrganization: { is: { name: contains } } },
      { affiliatedOrganization: { is: { name: contains } } },
    ],
  };
}

/** The Prisma filter for a search query, or null when the query is blank. */
export function organizationSearchWhere(query: string): Prisma.OrganizationWhereInput | null {
  const terms = searchTerms(query);
  if (terms.length === 0) return null;
  return { AND: terms.map(termMatches) };
}

/** A positive page number from a URL parameter; anything else is page 1. */
export function parsePageParam(value: string | undefined) {
  const page = Number.parseInt(value ?? "", 10);
  return Number.isFinite(page) && page > 0 ? Math.min(page, 10_000) : 1;
}

/** The query string for a list URL; blank and default values are left out. */
export function listSearchParams(values: { q?: string; kind?: string | null; status?: string | null; page?: number }) {
  const params = new URLSearchParams();
  if (values.q?.trim()) params.set("q", values.q);
  if (values.kind) params.set("kind", values.kind);
  if (values.status && values.status !== "ALL") params.set("status", values.status);
  if (values.page && values.page > 1) params.set("page", String(values.page));
  return params;
}
