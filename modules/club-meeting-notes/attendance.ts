import { toCsv } from "@/modules/reporting/csv";

/**
 * Meeting attendance (#653). Pure rules: which group a roster member sits in,
 * what the head counts become, and the attendance export. Names only, never a
 * birth date, contact or health field. Every CSV cell goes through `toCsv`.
 */

export type AttendanceGroup = "PATHFINDER" | "TLT" | "STAFF";

export const attendanceGroupLabels: Record<AttendanceGroup, string> = {
  PATHFINDER: "Pathfinders",
  TLT: "TLT",
  STAFF: "Staff",
};

export const attendanceGroupOrder: readonly AttendanceGroup[] = ["PATHFINDER", "TLT", "STAFF"];

/** The roster fields that decide a member's group. */
export type AttendanceMemberKind = { attendeeType: string; classLevel: string | null };

/** TLTs first, then staff and adults, then every other member (youth and underage) as a Pathfinder. */
export function attendanceGroupOf(member: AttendanceMemberKind): AttendanceGroup {
  if (member.classLevel === "TLT") return "TLT";
  if (member.attendeeType === "STAFF" || member.attendeeType === "ADULT") return "STAFF";
  return "PATHFINDER";
}

export type AttendanceRosterMember = AttendanceMemberKind & { id: string; firstName: string; lastName: string };

export function compareByName(a: { lastName: string; firstName: string }, b: { lastName: string; firstName: string }) {
  return a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);
}

/** The roster split into check-off groups, each sorted by last then first name; empty groups are left out. */
export function groupAttendanceRoster<T extends AttendanceRosterMember>(members: readonly T[]) {
  return attendanceGroupOrder
    .map((group) => ({
      group,
      label: attendanceGroupLabels[group],
      members: members.filter((member) => attendanceGroupOf(member) === group).sort(compareByName),
    }))
    .filter((entry) => entry.members.length > 0);
}

/**
 * The head counts a meeting's check-off produces: each present member counts
 * once, in exactly one group, so the three add up to everyone present.
 */
export function countsFromAttendance(members: ReadonlyArray<AttendanceMemberKind & { present: boolean }>) {
  const counts = { pathfinderCount: 0, tltCount: 0, staffCount: 0 };
  for (const member of members) {
    if (!member.present) continue;
    const group = attendanceGroupOf(member);
    if (group === "TLT") counts.tltCount += 1;
    else if (group === "STAFF") counts.staffCount += 1;
    else counts.pathfinderCount += 1;
  }
  return counts;
}

// ---------------------------------------------------------------- export

export type AttendanceExportMember = { id: string; firstName: string; lastName: string; group: AttendanceGroup };
export type AttendanceExportMeeting = { id: string; meetingDate: string };
/** `present` by `attendanceMarkKey`; a missing key means nothing was recorded for that pair. */
export type AttendanceExportMarks = ReadonlyMap<string, boolean>;

export const ATTENDANCE_EXPORT_FIXED_HEADERS = ["Last name", "First name", "Group"] as const;

export function attendanceMarkKey(meetingId: string, memberId: string) {
  return `${meetingId}:${memberId}`;
}

function percent(attended: number, recorded: number) {
  return recorded === 0 ? "" : `${Math.round((attended / recorded) * 100)}%`;
}

/**
 * The attendance export: one row per member, one column per meeting that took
 * attendance (Present / Absent, blank when nothing was recorded for that
 * person), then meetings attended, meetings recorded and percent attended,
 * with a totals row of how many were present at each meeting.
 */
export function attendanceExportCsv(
  context: { clubName: string; clubYear: string; from?: string; to?: string },
  meetings: readonly AttendanceExportMeeting[],
  members: readonly AttendanceExportMember[],
  marks: AttendanceExportMarks,
) {
  const sortedMeetings = [...meetings].sort((a, b) => a.meetingDate.localeCompare(b.meetingDate) || a.id.localeCompare(b.id));
  const sortedMembers = [...members].sort(
    (a, b) => attendanceGroupOrder.indexOf(a.group) - attendanceGroupOrder.indexOf(b.group) || compareByName(a, b),
  );
  const range = context.from || context.to ? `${context.from ?? "start"} to ${context.to ?? "end"}` : "Whole club year";
  const out: Array<Array<string | number>> = [
    ["Club", context.clubName],
    ["Club year", context.clubYear],
    ["Report", "Meeting attendance"],
    ["Dates", range],
    [],
    [...ATTENDANCE_EXPORT_FIXED_HEADERS, ...sortedMeetings.map((meeting) => meeting.meetingDate), "Meetings attended", "Meetings recorded", "Percent attended"],
  ];
  if (sortedMeetings.length === 0) {
    out.push(["No meetings with attendance recorded for the chosen dates."]);
    return toCsv(out);
  }
  for (const member of sortedMembers) {
    let attended = 0;
    let recorded = 0;
    const cells = sortedMeetings.map((meeting) => {
      const mark = marks.get(attendanceMarkKey(meeting.id, member.id));
      if (mark === undefined) return "";
      recorded += 1;
      if (mark) attended += 1;
      return mark ? "Present" : "Absent";
    });
    out.push([member.lastName, member.firstName, attendanceGroupLabels[member.group], ...cells, attended, recorded, percent(attended, recorded)]);
  }
  const presentPerMeeting = sortedMeetings.map((meeting) =>
    sortedMembers.filter((member) => marks.get(attendanceMarkKey(meeting.id, member.id)) === true).length);
  out.push(["Total present", "", "", ...presentPerMeeting, presentPerMeeting.reduce((sum, value) => sum + value, 0), "", ""]);
  return toCsv(out);
}

export function attendanceExportFileName(clubYear: string) {
  return `meeting-attendance-${clubYear}.csv`;
}
