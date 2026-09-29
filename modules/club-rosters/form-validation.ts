/**
 * Client-side checks for the "Add to roster" / edit form (#571 F-26), so each
 * invalid field gets its own inline, accessible message rather than only the
 * browser's tooltip. The server still validates everything; this only decides
 * what to say under which field.
 */

export type RosterFormField = "firstName" | "lastName" | "birthDate" | "gender";

export type RosterFormErrors = Partial<Record<RosterFormField, string>>;

/** Field order as shown, so focus lands on the first invalid one. */
export const rosterFormFieldOrder: readonly RosterFormField[] = ["firstName", "lastName", "birthDate", "gender"];

export function validateRosterForm(input: {
  firstName: string;
  lastName: string;
  /** Parsed `YYYY-MM-DD`, or empty when the typed text is missing or not a real date. */
  birthDate: string;
  /** What was typed in the birth date box. */
  birthDateText: string;
  gender: string;
  /** Editing keeps the stored birth date when the box is left blank. */
  editing: boolean;
}): RosterFormErrors {
  const errors: RosterFormErrors = {};
  if (!input.firstName.trim()) errors.firstName = "First name is required.";
  if (!input.lastName.trim()) errors.lastName = "Last name is required.";
  const typed = input.birthDateText.trim();
  if (typed && !input.birthDate) {
    errors.birthDate = "Enter a date like 4/17/2014, or 4/17/14.";
  } else if (!typed && !input.editing) {
    errors.birthDate = "Birth date is required.";
  }
  if (!input.gender) errors.gender = "Choose a gender.";
  return errors;
}
