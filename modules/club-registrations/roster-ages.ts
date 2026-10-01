/**
 * Ages typed in for roster people with no birth date (#639). Pure helpers,
 * safe on the client and the server.
 */

type AgeState = {
  rosterAges: Record<string, number>;
  attendeeResponses: Record<string, Record<string, unknown>>;
};

/** Whole years, 0 to 120: the same rule guests have. */
export function parseTypedAge(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const age = Number(raw);
  return Number.isInteger(age) && age >= 0 && age <= 120 ? age : undefined;
}

/**
 * Sets (or clears, with `undefined`) one person's typed-in age, and mirrors it
 * into their event-form answers under the form's age field, when it has one,
 * so the form shows it. The server sets that answer again at submit.
 */
export function withRosterAge<T extends AgeState>(state: T, memberId: string, age: number | undefined, ageKey: string | null): T {
  const rosterAges = { ...state.rosterAges };
  if (age === undefined) delete rosterAges[memberId];
  else rosterAges[memberId] = age;
  const attendeeResponses = { ...state.attendeeResponses };
  if (ageKey) {
    const { [ageKey]: previous, ...others } = attendeeResponses[memberId] ?? {};
    void previous;
    attendeeResponses[memberId] = age === undefined ? others : { ...others, [ageKey]: String(age) };
  }
  return { ...state, rosterAges, attendeeResponses };
}

type AgeInputPerson = { memberId: string; firstName: string; lastName: string; ageOnEventDate: number | null; reportedAge: number | null };

/**
 * What an "Age on event date" field shows: the director's own text once they
 * have edited it, else the age saved in the draft, else the roster's reported age.
 */
export function ageInputValue(person: AgeInputPerson, text: Readonly<Record<string, string>>, saved: Readonly<Record<string, number>>): string {
  return text[person.memberId] ?? String(saved[person.memberId] ?? person.reportedAge ?? "");
}

/** What is wrong with this person's age entry, or null. A blank entry is never read as the reported age. */
export function ageInputProblem(person: AgeInputPerson, text: Readonly<Record<string, string>>, saved: Readonly<Record<string, number>>): string | null {
  if (person.ageOnEventDate !== null) return null;
  const raw = ageInputValue(person, text, saved);
  if (raw.trim() === "") return `Enter ${`${person.firstName} ${person.lastName}`.trim() || "their"} age on the event date.`;
  return parseTypedAge(raw) === undefined ? "Enter the age as a whole number from 0 to 120." : null;
}

/** The age in use for each going person with no birth date. Once edited, the reported age never stands in again. */
export function effectiveRosterAges(
  roster: readonly AgeInputPerson[],
  selectedMemberIds: readonly string[],
  text: Readonly<Record<string, string>>,
  saved: Readonly<Record<string, number>>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const person of roster) {
    if (person.ageOnEventDate !== null || !selectedMemberIds.includes(person.memberId)) continue;
    const age = parseTypedAge(ageInputValue(person, text, saved));
    if (age !== undefined) result[person.memberId] = age;
  }
  return result;
}

/** Going people whose age is blank or invalid, in roster order: who still blocks Continue (#718). */
export function peopleMissingAges<T extends AgeInputPerson>(
  roster: readonly T[],
  selectedMemberIds: readonly string[],
  text: Readonly<Record<string, string>>,
  saved: Readonly<Record<string, number>>,
): T[] {
  return roster.filter((person) => selectedMemberIds.includes(person.memberId) && ageInputProblem(person, text, saved) !== null);
}

/** The id of a person's "Age on event date" input, so Continue can scroll to and focus it. */
export function ageFieldId(memberId: string): string {
  return `club-age-${memberId}`;
}

/** What Continue says while ages are still needed, e.g. "Enter 3 ages to continue". */
export function agesNeededLabel(count: number): string {
  return `Enter ${count} ${count === 1 ? "age" : "ages"} to continue`;
}
