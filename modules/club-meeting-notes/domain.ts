import { MAX_HONORS, type ReportHonor } from "@/modules/club-reports/domain";

/**
 * Club meeting notes (#426): one simple record per meeting so the monthly
 * report doesn't retype every number. No names of young people — attendance
 * is counts only; free text is the club's own, not a Pathfinder's.
 */

export type MeetingNoteCounts = { pathfinderCount: number | null; tltCount: number | null; staffCount: number | null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-31). */
export function isMeetingDate(value: string) {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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

  // Honors match case-insensitively; the first spelling seen is kept.
  const honorParticipants = new Map<string, ReportHonor>();
  for (const note of notes) {
    for (const honor of note.honors) {
      const name = honor.name.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const current = honorParticipants.get(key);
      if (current === undefined) {
        honorParticipants.set(key, { name, participants: honor.participants });
      } else if (honor.participants !== null && (current.participants === null || honor.participants > current.participants)) {
        current.participants = honor.participants;
      }
    }
  }
  // A report lists at most MAX_HONORS; keep the ones the most Pathfinders worked on.
  const honors = [...honorParticipants.values()]
    .map((honor, order) => ({ honor, order }))
    .sort((a, b) => (b.honor.participants ?? -1) - (a.honor.participants ?? -1) || a.order - b.order)
    .slice(0, MAX_HONORS)
    .map(({ honor }) => honor);

  return {
    averageAttendance: average(attendanceValues),
    pathfinderCount: average(pathfinderValues),
    tltCount: average(tltValues),
    staffCount: average(staffValues),
    honors,
  };
}

export type NotesMonthlySummary = NonNullable<ReturnType<typeof notesMonthlySummary>>;
