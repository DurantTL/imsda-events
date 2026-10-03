/**
 * Short choice lists show as radio cards instead of a dropdown (#743): every
 * option is visible at once and one tap picks it. The same values and field
 * names are saved either way. Longer lists stay dropdowns, and so do the
 * fields that are dropdowns by nature: a directory (church, club, school),
 * country, state or region, timezone and quantities.
 */
export const RADIO_CARD_MAX_OPTIONS = 4;

export function usesRadioCards(optionCount: number) {
  return optionCount >= 1 && optionCount <= RADIO_CARD_MAX_OPTIONS;
}

const DROPDOWN_BY_NATURE = /\b(country|countries|state|province|region|time ?zone|quantity|qty)\b/i;

export function selectUsesRadioCards(field: { key: string; label: string; options: readonly string[]; optionSource?: string }) {
  if (!usesRadioCards(field.options.length)) return false;
  if (field.optionSource) return false;
  const normalize = (text: string) => text.replace(/[_-]+/g, " ");
  return !DROPDOWN_BY_NATURE.test(normalize(field.key)) && !DROPDOWN_BY_NATURE.test(normalize(field.label));
}
