/**
 * Slug shaping shared between the server (creating a form and, per #476,
 * updating its web address before a first publish) and the registration
 * builder UI, which uses the same function to detect when a renamed form's
 * title no longer matches its current slug. Deliberately has no
 * `server-only` import so the client component can call it directly.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "registration-form";
}
