/**
 * The attendee roster's label as a count reads it: "team member or coach" is "1 team member or coach" and
 * "2 team members or coaches"; "person" is "people". Pure and client-safe, so the form, the builder and the server's
 * validation messages say the same thing (#809). The label is lower-cased, as every site showed it.
 */

const IRREGULAR: Readonly<Record<string, string>> = { person: "people", child: "children", man: "men", woman: "women" };

function pluralWord(word: string): string {
  const lower = word.toLowerCase();
  const irregular = IRREGULAR[lower];
  if (irregular) return irregular;
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

/** The plural of a label: the last word of each "or"/"and" part is made plural. */
export function pluralizeAttendeeLabel(label: string): string {
  const trimmed = label.trim().toLowerCase();
  if (!trimmed) return trimmed;
  return trimmed
    .split(/(\s+(?:or|and)\s+)/)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      const words = part.split(/\s+/);
      words[words.length - 1] = pluralWord(words[words.length - 1] ?? "");
      return words.join(" ");
    })
    .join("");
}

/** The label for a count: the singular when the count is 1, otherwise the plural. */
export function pluralAttendeeLabel(label: string, count: number): string {
  return count === 1 ? label.trim().toLowerCase() : pluralizeAttendeeLabel(label);
}
