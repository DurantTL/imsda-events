/**
 * Wording and guidance shared by the two class pickers: the one on a
 * registered club's page and the honors step of a new registration (#618).
 * Guidance only; the server enforces every rule when picks are saved.
 */

type ViewOffering = {
  perClubLimit: number | null;
  minimumAge: number | null;
  isActive: boolean;
} & (
  | { capacity: number; seatsTaken: number; clubSeatsTaken: number }
  // The public group catalog (#650): only how many seats are left, never the capacity or who holds them.
  | { seatsLeft: number }
);

/**
 * A class as the public group page gets it: the class itself, plus only how
 * many seats are left. The capacity and the number taken stay on the server.
 * (Teacher and per-group limit are already public on the event's info cards.)
 */
export type PublicSeatView<T extends { capacity: number; seatsTaken: number; clubSeatsTaken: number }> =
  Omit<T, "capacity" | "seatsTaken" | "clubSeatsTaken"> & { seatsLeft: number };

export function toPublicSeatView<T extends { capacity: number; seatsTaken: number; clubSeatsTaken: number }>(offering: T): PublicSeatView<T> {
  const { capacity, seatsTaken, clubSeatsTaken: _clubSeatsTaken, ...rest } = offering;
  void _clubSeatsTaken;
  return { ...rest, seatsLeft: Math.max(capacity - seatsTaken, 0) };
}

function seatsLeftOf(offering: ViewOffering) {
  return "seatsLeft" in offering ? offering.seatsLeft : offering.capacity - offering.seatsTaken;
}

function clubSeatsTakenOf(offering: ViewOffering) {
  return "clubSeatsTaken" in offering ? offering.clubSeatsTaken : 0;
}

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

/** Who the per-club limit counts: a club, or a "Group" registration that is its own club for the limit (#650). */
export type SeatOwnerNoun = "club" | "group";

export function seatsNote(offering: ViewOffering, heldHere: boolean, attendee: ViewAttendee, noun: SeatOwnerNoun = "club") {
  if (!attendee.consumesSeat) return "no seat needed";
  if (heldHere) return "seat held";
  const left = seatsLeftOf(offering);
  const clubLeft = offering.perClubLimit === null ? null : offering.perClubLimit - clubSeatsTakenOf(offering);
  const parts = [`${Math.max(left, 0)}${"capacity" in offering ? ` of ${offering.capacity}` : ""} seats left`];
  if (clubLeft !== null) parts.push(`${Math.max(clubLeft, 0)} left for your ${noun}`);
  return parts.join(", ");
}

export function unavailableReason(offering: ViewOffering, heldHere: boolean, attendee: ViewAttendee) {
  if (heldHere) return null;
  if (!offering.isActive) return "no longer offered";
  if (offering.minimumAge !== null && (attendee.ageOnEventDate === null || attendee.ageOnEventDate < offering.minimumAge)) {
    return `ages ${offering.minimumAge}+`;
  }
  if (!attendee.consumesSeat) return null;
  if (seatsLeftOf(offering) <= 0) return "full";
  if (offering.perClubLimit !== null && clubSeatsTakenOf(offering) >= offering.perClubLimit) return "club limit reached";
  return null;
}
