import type { AreaClubSummary } from "@/modules/club-reports/area-summary-domain";
import { calendarDateIn } from "@/modules/calendar/domain";

/**
 * The Area Coordinator's home card (#656): pure helpers over already-loaded
 * rows. Counts only for clubs needing attention, never a name or a note (#479).
 */

export type AreaCardLink = { href: string; label: string };

/** Quick links on the card. Add the health view here when #658 lands. */
export function areaCardLinks(): AreaCardLink[] {
  return [
    { href: "/account/area-clubs/overview", label: "Clubs overview" },
    { href: "/account/area-clubs/events", label: "Club event registrations" },
  ];
}

export type RegistrationWindow = { label: string; open: boolean };

/** Open/closed wording from the event's (or location's) `YYYY-MM-DD` window, compared in the conference time zone. */
export function registrationWindow(
  opensOn: string | null,
  closesOn: string | null,
  now: Date,
): RegistrationWindow {
  const today = calendarDateIn(now);
  if (opensOn && today < opensOn) return { label: `Opens ${opensOn}`, open: false };
  if (closesOn && today > closesOn) return { label: "Closed", open: false };
  return { label: closesOn ? `Open, closes ${closesOn}` : "Open", open: true };
}

function hasBackgroundCheckReminder(club: AreaClubSummary) {
  const checks = club.backgroundChecks;
  return checks.missing + checks.notInCompliance + checks.expiringSoon > 0;
}

/** Clubs with a month past due, or any background-check reminder (counts only). */
export function clubsNeedingAttention(clubs: readonly AreaClubSummary[]) {
  return {
    overdueReports: clubs.filter((club) => club.missing > 0).length,
    backgroundCheckReminders: clubs.filter(hasBackgroundCheckReminder).length,
    either: clubs.filter((club) => club.missing > 0 || hasBackgroundCheckReminder(club)).length,
  };
}
