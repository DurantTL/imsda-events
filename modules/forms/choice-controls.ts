/**
 * Short choice lists show as radio cards instead of a dropdown (#743): every
 * option is visible at once and one tap picks it. The same values and field
 * names are saved either way; longer lists (church, country, timezone) stay
 * dropdowns.
 */
export const RADIO_CARD_MAX_OPTIONS = 4;

export function usesRadioCards(optionCount: number) {
  return optionCount >= 1 && optionCount <= RADIO_CARD_MAX_OPTIONS;
}
