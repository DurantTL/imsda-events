/**
 * Structured address field support: the shape of an address answer, input
 * sanitization (the "exact submitted snapshot" that responses persist),
 * deterministic normalization for search / duplicate-match evidence, and a
 * stable flattened display value for exports.
 *
 * This module intentionally does NOT verify or geocode addresses and does
 * NOT decide identity matches — `normalizeAddress` only gives callers (for
 * example a future duplicate-match workflow) a deterministic comparison key
 * from whatever was submitted. It is evidence, not proof.
 */

export const addressComponentKeys = [
  "line1",
  "line2",
  "locality",
  "region",
  "postalCode",
  "country",
] as const;

export type AddressComponentKey = typeof addressComponentKeys[number];
export type AddressValue = Partial<Record<AddressComponentKey, string>>;

export const addressComponentLabels: Record<AddressComponentKey, string> = {
  line1: "Address line 1",
  line2: "Address line 2",
  locality: "City / locality",
  region: "State / province / region",
  postalCode: "ZIP / postal code",
  country: "Country",
};

// Components required for a usable postal address anywhere in the world.
// Region and postal code are intentionally optional: many countries have no
// postal code, and some have no first-level administrative region either.
const requiredAddressComponents: readonly AddressComponentKey[] = [
  "line1",
  "locality",
  "country",
];

const maxComponentLength = 200;

export function isPlainAddressObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringComponent(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Sanitize a raw submitted value into the address field's stored shape:
 * only the known component keys, trimmed, length-capped, with empty
 * components omitted. Applying this on submit is what makes the stored
 * responses the field's structured, exact submitted snapshot — later label
 * or help-text edits on the field never touch already-stored responses.
 */
export function sanitizeAddressInput(value: unknown): AddressValue {
  if (!isPlainAddressObject(value)) return {};
  const sanitized: AddressValue = {};
  for (const key of addressComponentKeys) {
    const component = stringComponent(value[key]).slice(0, maxComponentLength);
    if (component) sanitized[key] = component;
  }
  return sanitized;
}

export function hasAddressValue(value: unknown) {
  const sanitized = sanitizeAddressInput(value);
  return addressComponentKeys.some((key) => Boolean(sanitized[key]));
}

/**
 * Validation issues for a submitted address, given the field's label for
 * message text. Supports international and partial addresses: only line 1,
 * locality, and country are required, so countries without postal codes or
 * first-level regions still validate.
 */
export function validateAddressValue(label: string, value: unknown): string[] {
  const issues: string[] = [];
  if (!isPlainAddressObject(value)) {
    return [`${label} must be a valid address.`];
  }
  const sanitized = sanitizeAddressInput(value);
  for (const key of requiredAddressComponents) {
    if (!sanitized[key]) {
      issues.push(`${label} needs ${addressComponentLabels[key].toLocaleLowerCase("en-US")}.`);
    }
  }
  for (const key of addressComponentKeys) {
    const raw = stringComponent((value as Record<string, unknown>)[key]);
    if (raw.length > maxComponentLength) {
      issues.push(`${label} — ${addressComponentLabels[key]} must be ${maxComponentLength} characters or fewer.`);
    }
  }
  return issues;
}

function normalizeComponent(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleUpperCase("en-US");
}

export type NormalizedAddress = Record<AddressComponentKey, string> & { matchKey: string };

/**
 * Deterministic normalization for search / duplicate-match evidence. Same
 * input always produces the same output; there is no network call, no
 * geocoding, and no verification against an external address database.
 */
export function normalizeAddress(value: unknown): NormalizedAddress {
  const sanitized = sanitizeAddressInput(value);
  const normalized = Object.fromEntries(
    addressComponentKeys.map((key) => [key, normalizeComponent(sanitized[key] ?? "")]),
  ) as Record<AddressComponentKey, string>;
  const matchKey = addressComponentKeys
    .map((key) => normalized[key])
    .filter(Boolean)
    .join("|");
  return { ...normalized, matchKey };
}

/**
 * Stable, human-readable flattened value used for read-only display and as
 * the single-column export value alongside the structured columns. Blank
 * components are skipped; ordering is deterministic.
 */
export function formatAddressDisplay(value: unknown): string {
  const sanitized = sanitizeAddressInput(value);
  const streetLine = [sanitized.line1, sanitized.line2].filter(Boolean).join(", ");
  const cityRegion = [sanitized.locality, sanitized.region].filter(Boolean).join(", ");
  const cityRegionPostal = [cityRegion, sanitized.postalCode].filter(Boolean).join(" ").trim();
  return [streetLine, cityRegionPostal, sanitized.country].filter(Boolean).join(", ");
}

/** Export column headers for one address field: structured components plus the flattened display column. */
export function addressCsvColumns(label: string): string[] {
  return [
    ...addressComponentKeys.map((key) => `${label} — ${addressComponentLabels[key]}`),
    `${label} (formatted)`,
  ];
}

/**
 * Export row values for one address field, as plain strings. Callers must
 * still pass these through a formula-safe CSV cell escaper (for example
 * `csvCell` from `@/modules/reporting/csv`) before writing them out — this
 * function does not escape, it only produces the structured + flattened
 * values in a stable order.
 */
export function addressCsvValues(value: unknown): string[] {
  const sanitized = sanitizeAddressInput(value);
  return [
    ...addressComponentKeys.map((key) => sanitized[key] ?? ""),
    formatAddressDisplay(value),
  ];
}
