/**
 * Wording and guidance shared by the two class pickers: the one on a
 * registered club's page and the honors step of a new registration (#618).
 * Guidance only; the server enforces every rule when picks are saved.
 */

type ViewOffering = {
  capacity: number;
  seatsTaken: number;
  perClubLimit: number | null;
  clubSeatsTaken: number;
  minimumAge: number | null;
  isActive: boolean;
};

type ViewAttendee = {
  attendeeType: string | null;
  consumesSeat: boolean;
  ageOnEventDate: number | null;
};

/** What the roster calls this person; underage children are youth but take no seat (#462). */
export function attendeeTypeLabel(attendee: Pick<ViewAttendee, "attendeeType">) {
  if (attendee.attendeeType === "STAFF") return "Staff";
  if (attendee.attendeeType === "ADULT") return "Adult";
  if (attendee.attendeeType === "UNDERAGE") return "Underage";
  return "Youth";
}

export function seatsNote(offering: ViewOffering, heldHere: boolean, attendee: ViewAttendee) {
  if (!attendee.consumesSeat) return "no seat needed";
  if (heldHere) return "seat held";
  const left = offering.capacity - offering.seatsTaken;
  const clubLeft = offering.perClubLimit === null ? null : offering.perClubLimit - offering.clubSeatsTaken;
  const parts = [`${Math.max(left, 0)} of ${offering.capacity} seats left`];
  if (clubLeft !== null) parts.push(`${Math.max(clubLeft, 0)} left for your club`);
  return parts.join(", ");
}

export function unavailableReason(offering: ViewOffering, heldHere: boolean, attendee: ViewAttendee) {
  if (heldHere) return null;
  if (!offering.isActive) return "no longer offered";
  if (offering.minimumAge !== null && (attendee.ageOnEventDate === null || attendee.ageOnEventDate < offering.minimumAge)) {
    return `ages ${offering.minimumAge}+`;
  }
  if (!attendee.consumesSeat) return null;
  if (offering.seatsTaken >= offering.capacity) return "full";
  if (offering.perClubLimit !== null && offering.clubSeatsTaken >= offering.perClubLimit) return "club limit reached";
  return null;
}
