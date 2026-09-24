import type { ReportHonor } from "@/modules/club-reports/domain";

/**
 * Club meeting notes (#426): one simple record per meeting so the monthly
 * report doesn't retype every number. No names of young people — attendance
 * is counts only; free text is the club's own, not a Pathfinder's.
 */

export type MeetingNoteCounts = { pathfinderCount: number | null; tltCount: number | null; staffCount: number | null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isMeetingDate(value: string) {
  return DATE.test(value);
}

/** "2026-10-14" → "2026-10". */
export function meetingNoteMonth(meetingDate: string) {
  return meetingDate.slice(0, 7);
}

function average(values: readonly number[]) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * What a new monthly report prefills from a month's meeting notes: average
 * attendance and the Pathfinder/TLT/staff counts, each averaged over the
 * meetings that recorded it, and the month's honors worked on. A month with
 * no notes, or no notes with a given count, prefills nothing for that field.
 */
export function notesMonthlySummary(notes: ReadonlyArray<MeetingNoteCounts & { honors: readonly ReportHonor[] }>) {
  if (notes.length === 0) return null;
  const only = (pick: (note: MeetingNoteCounts) => number | null) =>
    notes.map(pick).filter((value): value is number => value !== null);
  const pathfinderValues = only((note) => note.pathfinderCount);
  const tltValues = only((note) => note.tltCount);
  const staffValues = only((note) => note.staffCount);
  const attendanceValues = notes
    .filter((note) => note.pathfinderCount !== null || note.tltCount !== null || note.staffCount !== null)
    .map((note) => (note.pathfinderCount ?? 0) + (note.tltCount ?? 0) + (note.staffCount ?? 0));

  const honorParticipants = new Map<string, number | null>();
  for (const note of notes) {
    for (const honor of note.honors) {
      const name = honor.name.trim();
      if (!name) continue;
      const current = honorParticipants.get(name);
      if (current === undefined) {
        honorParticipants.set(name, honor.participants);
      } else if (honor.participants !== null && (current === null || honor.participants > current)) {
        honorParticipants.set(name, honor.participants);
      }
    }
  }

  return {
    averageAttendance: average(attendanceValues),
    pathfinderCount: average(pathfinderValues),
    tltCount: average(tltValues),
    staffCount: average(staffValues),
    honors: [...honorParticipants.entries()].map(([name, participants]) => ({ name, participants })) as ReportHonor[],
  };
}

export type NotesMonthlySummary = NonNullable<ReturnType<typeof notesMonthlySummary>>;
