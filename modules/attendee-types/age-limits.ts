/**
 * The one age range every age input and age check uses (#743): whole years,
 * 0 to 120. Pure, so forms and servers share it.
 */
export const MIN_AGE_YEARS = 0;
export const MAX_AGE_YEARS = 120;

export function isWholeAgeInRange(age: number) {
  return Number.isInteger(age) && age >= MIN_AGE_YEARS && age <= MAX_AGE_YEARS;
}

/** The attributes an age text box carries: numeric keypad on phones, and the shared range. */
export const ageInputAttributes = { inputMode: "numeric" as const, min: MIN_AGE_YEARS, max: MAX_AGE_YEARS, step: 1 };
