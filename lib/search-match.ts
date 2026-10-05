/**
 * Word-based text search shared by the club pages' pickers and filters (#799 G2).
 *
 * Every typed word has to appear somewhere in the text, in any order, ignoring
 * case, accents, and punctuation. So "Smith, Jo" finds "Jo Smith", "shirt polo"
 * finds "Polo Shirt", and "ab 123" finds catalog number "AB-123". A blank
 * search matches everything.
 */

function fold(value: string) {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** The words of a search: split on spaces and punctuation, accents removed. */
export function searchWords(query: string) {
  return fold(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Does every word of `query` appear in one of the `fields`? */
export function matchesSearch(fields: ReadonlyArray<string | null | undefined>, query: string) {
  const words = searchWords(query);
  if (words.length === 0) return true;
  const folded = fields.filter((field): field is string => Boolean(field)).map(fold).join(" ");
  const spaced = folded.replace(/[^\p{L}\p{N}]+/gu, " ");
  // "AB-123" must also match a search for "ab123".
  const compact = folded.replace(/[^\p{L}\p{N}]+/gu, "");
  return words.every((word) => spaced.includes(word) || compact.includes(word));
}

/**
 * The option a picker should treat as chosen: the one the person picked while
 * it is still listed, otherwise the only match (so typing a full name needs no
 * second click), otherwise none. Never an item the search has since hidden.
 */
export function effectiveChoice(chosenId: string, listed: ReadonlyArray<{ id: string }>) {
  if (chosenId && listed.some((entry) => entry.id === chosenId)) return chosenId;
  return listed.length === 1 ? listed[0]!.id : "";
}
