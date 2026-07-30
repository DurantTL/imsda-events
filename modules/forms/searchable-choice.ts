export function normalizeChoiceSearch(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .trim();
}

export function filterSearchableChoices<T extends { label: string }>(
  choices: readonly T[],
  query: string,
) {
  const terms = normalizeChoiceSearch(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...choices];
  return choices.filter((choice) => {
    const searchable = normalizeChoiceSearch(choice.label);
    return terms.every((term) => searchable.includes(term));
  });
}
