import type { RegistrationFormField } from "@/modules/forms/definition";

/**
 * Form-builder helpers for a per-unit credit field (#409, e.g. Camporee's
 * meal-sponsorship credit). The builder has no editor for a credit: a
 * template sets it, and the builder shows it read-only with a way to remove
 * it. A credit is valid only on a registration-level number field with no
 * price, so any edit that breaks that clears the credit instead of leaving a
 * definition the schema would reject.
 */

const creditCleared = { creditCentsPerUnit: undefined, capUnitsAtAttendeeCount: undefined } satisfies Partial<RegistrationFormField>;

export function hasCredit(field: Pick<RegistrationFormField, "creditCentsPerUnit">) {
  return field.creditCentsPerUnit !== undefined;
}

/** "Credit: $5.00 per unit, capped at headcount", or null for a field with no credit. */
export function creditSummary(
  field: Pick<RegistrationFormField, "creditCentsPerUnit" | "capUnitsAtAttendeeCount">,
) {
  if (field.creditCentsPerUnit === undefined) return null;
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
    .format(Math.abs(field.creditCentsPerUnit) / 100);
  return `Credit: ${amount} per unit${field.capUnitsAtAttendeeCount ? ", capped at headcount" : ""}`;
}

/** The patch that removes a field's credit. */
export function removeCreditPatch(): Partial<RegistrationFormField> {
  return { ...creditCleared };
}

/**
 * Extra patch for a type or scope change: a credit survives only while the
 * field stays a registration-level number field.
 */
export function creditPatchForKindChange(
  field: Pick<RegistrationFormField, "creditCentsPerUnit" | "type" | "scope">,
  next: { type?: RegistrationFormField["type"]; scope?: RegistrationFormField["scope"] },
): Partial<RegistrationFormField> {
  if (!hasCredit(field)) return {};
  const type = next.type ?? field.type;
  const scope = next.scope ?? field.scope;
  return type === "NUMBER" && scope === "REGISTRATION" && type === field.type && scope === field.scope
    ? {}
    : { ...creditCleared };
}
