/**
 * Slug shaping shared between the server (creating a form and, per #476,
 * updating its web address before a first publish) and the registration
 * builder UI, which uses the same function to detect when a renamed form's
 * title no longer matches its current slug. Deliberately has no
 * `server-only` import so the client component can call it directly.
 */
export const MAX_FORM_SLUG_LENGTH = 60;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_FORM_SLUG_LENGTH)
    // Slicing can cut just after a separator; a trailing hyphen would fail
    // the web-address schema.
    .replace(/-+$/, "") || "registration-form";
}

/**
 * The `suffix`-th candidate address for a base slug, as form creation tries
 * them: `base`, then `base-2`, `base-3`, … The base is shortened when needed
 * so the candidate still fits the web-address length limit.
 */
export function slugCandidate(baseSlug: string, suffix: number): string {
  if (suffix < 2) return baseSlug;
  const tail = `-${suffix}`;
  const head = baseSlug.slice(0, MAX_FORM_SLUG_LENGTH - tail.length).replace(/-+$/, "");
  return `${head}${tail}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a form's slug already reflects its title. A slug that is the
 * title's slug plus a numeric suffix (`title-2`, `title-3`, …) counts as
 * matching: creation adds that suffix when the plain address was taken, so
 * the form was never renamed and prompting would only offer an address
 * that is already in use.
 */
export function slugMatchesTitle(slug: string, title: string): boolean {
  const expected = slugify(title);
  if (slug === expected) return true;
  // Created as `title-N` because the plain address was taken (including
  // the shortened form `slugCandidate` produces for very long titles).
  const suffix = /-(\d+)$/.exec(slug);
  if (!suffix) return false;
  if (new RegExp(`^${escapeRegExp(expected)}-\\d+$`).test(slug)) return true;
  return slug === slugCandidate(expected, Number(suffix[1]));
}
