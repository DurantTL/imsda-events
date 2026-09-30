/**
 * Ages typed in for roster people with no birth date (#639). Pure helpers,
 * safe on the client and the server.
 */

type AgeState = {
  rosterAges: Record<string, number>;
  attendeeResponses: Record<string, Record<string, unknown>>;
};

type RosterAgeSource = { memberId: string; ageOnEventDate: number | null; reportedAge: number | null };

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

/**
 * Starts the age field at the roster's reported age for anyone going who has
 * no birth date and no age typed in yet. Still editable, still required.
 */
export function withReportedAgePrefill<T extends AgeState>(
  state: T,
  roster: readonly RosterAgeSource[],
  memberIds: readonly string[],
  ageKey: string | null,
): T {
  let next = state;
  for (const person of roster) {
    if (!memberIds.includes(person.memberId)) continue;
    if (person.ageOnEventDate !== null || person.reportedAge === null) continue;
    if (next.rosterAges[person.memberId] !== undefined) continue;
    next = withRosterAge(next, person.memberId, person.reportedAge, ageKey);
  }
  return next;
}

/** The reported ages that stand in for ages not typed in yet: only for people going with no birth date. */
export function reportedAgeDefaults(
  roster: readonly RosterAgeSource[],
  memberIds: readonly string[],
  typed: Readonly<Record<string, number>>,
): Record<string, number> {
  const defaults: Record<string, number> = {};
  for (const person of roster) {
    if (!memberIds.includes(person.memberId)) continue;
    if (person.ageOnEventDate !== null || person.reportedAge === null) continue;
    if (typed[person.memberId] !== undefined) continue;
    defaults[person.memberId] = person.reportedAge;
  }
  return defaults;
}
