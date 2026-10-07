/**
 * The `attendance` part of a meeting-note save (#653, #810). Omitted leaves the
 * meeting's check-off alone; a list sets it; an empty list clears it. Only a
 * touched check-off is sent. `hadAttendance` is the saved note's own flag (from
 * the note being edited or the last save response), never a lookup in the
 * month's list, so a note dated outside the month shown still clears.
 */
export function attendanceForSave({
  available,
  touched,
  on,
  rosterMatchesDate,
  hadAttendance,
  roster,
  present,
}: {
  available: boolean;
  touched: boolean;
  on: boolean;
  rosterMatchesDate: boolean;
  hadAttendance: boolean;
  roster: ReadonlyArray<{ id: string }>;
  present: Readonly<Record<string, boolean>>;
}): { attendance?: Array<{ rosterMemberId: string; present: boolean }> } {
  if (!available || !touched) return {};
  if (on && rosterMatchesDate) return { attendance: roster.map((member) => ({ rosterMemberId: member.id, present: present[member.id] === true })) };
  if (!on && hadAttendance) return { attendance: [] };
  return {};
}
