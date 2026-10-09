/**
 * Honors Weekend class waitlist (#831). Pure rules; the repository applies them
 * inside the same serializable transaction that takes class seats (#359).
 *
 * A full class has a waitlist of youth, in the order they joined. When a seat
 * opens, the next youth in line is OFFERED it, and the club's director has the
 * event's acceptance window to accept. An offer not accepted in time passes to
 * the next youth. A live offer reserves its seat (it counts with the taken
 * seats), so a class is never overfilled. Waitlist spots are not seats and
 * never count toward a club's per-club youth limit.
 */

export const waitlistOfferHoursDefault = 24;
export const waitlistOfferHoursMin = 1;
export const waitlistOfferHoursMax = 168;

export const waitlistStatuses = ["WAITING", "OFFERED", "ACCEPTED", "DECLINED", "EXPIRED", "REMOVED"] as const;
export type WaitlistStatus = (typeof waitlistStatuses)[number];

/** Statuses where the youth still has a place in line (the database allows one per person and class). */
export const openWaitlistStatuses = ["WAITING", "OFFERED"] as const satisfies readonly WaitlistStatus[];

/** When an offer made `now` runs out. */
export function offerExpiresAt(now: Date, hours: number) {
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

/** An offer is live while it has not run out; at the very instant of expiry it has lapsed. */
export function offerIsLive(entry: { status: WaitlistStatus; offerExpiresAt: Date | null }, now: Date) {
  return entry.status === "OFFERED" && entry.offerExpiresAt !== null && entry.offerExpiresAt.getTime() > now.getTime();
}

/** Seats a class can still give: capacity, less the seats taken and the seats held by live offers. Never below zero. */
export function seatsFree(capacity: number, taken: number, reservedByOffers: number) {
  return Math.max(capacity - taken - reservedByOffers, 0);
}

/**
 * Whether a person already holds a class that clashes with `offering` in time:
 * any class in the same session, an all-sessions class, or (for an all-sessions
 * offering) any class at all. Holding the class itself counts too.
 */
export function holdsConflictingClass(
  offering: { id: string; span: "SINGLE_SESSION" | "ALL_SESSIONS"; sessionId: string | null },
  held: ReadonlyArray<{ id: string; span: "SINGLE_SESSION" | "ALL_SESSIONS"; sessionId: string | null }>,
) {
  for (const other of held) {
    if (other.id === offering.id) return true;
    if (offering.span === "ALL_SESSIONS" || other.span === "ALL_SESSIONS") return true;
    if (offering.sessionId && other.sessionId === offering.sessionId) return true;
  }
  return false;
}

export type OfferCandidate = {
  id: string;
  organizationId: string | null;
  /** Why this entry can't be offered right now, or null. A skipped entry keeps its place in line. */
  skipReason: string | null;
};

export type OfferPlan = {
  offered: string[];
  skipped: Array<{ id: string; reason: string }>;
};

/**
 * Which waiting entries get the free seats, in the order they joined. `candidates`
 * must already be in join order. Entries that can't take a seat now (the youth
 * already holds a class in that session, no longer meets the class's rules, the
 * class-change deadline has passed, the club is at its per-club limit) are
 * skipped and keep their place; the seat goes to the next in line.
 *
 * The per-club limit counts seats, never waitlist spots: a club's seats in the
 * class plus its live offers (a held offer becomes a seat once accepted).
 */
export function planOffers(input: {
  freeSeats: number;
  candidates: readonly OfferCandidate[];
  perClubLimit: number | null;
  /** Seats held in this class, by club (organization id); a group registration has none. */
  clubSeats: ReadonlyMap<string, number>;
  /** Live offers in this class, by club. */
  clubLiveOffers: ReadonlyMap<string, number>;
}): OfferPlan {
  const offered: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const added = new Map<string, number>();
  let left = input.freeSeats;
  for (const candidate of input.candidates) {
    if (left <= 0) break;
    if (candidate.skipReason) {
      skipped.push({ id: candidate.id, reason: candidate.skipReason });
      continue;
    }
    const club = candidate.organizationId;
    if (input.perClubLimit !== null && club) {
      const used = (input.clubSeats.get(club) ?? 0) + (input.clubLiveOffers.get(club) ?? 0) + (added.get(club) ?? 0);
      if (used >= input.perClubLimit) {
        skipped.push({ id: candidate.id, reason: "Their club is at the class's per-club limit." });
        continue;
      }
      added.set(club, (added.get(club) ?? 0) + 1);
    }
    offered.push(candidate.id);
    left -= 1;
  }
  return { offered, skipped };
}

/** A youth's place in line among the entries still waiting or holding an offer, counted from 1 (the order they joined). */
export function placeInLine(joinOrders: readonly number[], joinOrder: number) {
  return joinOrders.filter((other) => other < joinOrder).length + 1;
}

/** The director-facing sentence for an entry that is waiting but can't take a seat right now. */
export function waitingNote(reason: "HOLDS_CLASS_IN_SESSION" | "NOT_ELIGIBLE" | "DEADLINE_PASSED" | "CLUB_LIMIT") {
  switch (reason) {
    case "HOLDS_CLASS_IN_SESSION":
      return "Already has a class in this session, so a seat will go to the next youth. They keep their place.";
    case "NOT_ELIGIBLE":
      return "Doesn't currently meet this class's requirements, so a seat will go to the next youth. They keep their place.";
    case "DEADLINE_PASSED":
      return "Class changes have closed, so no more seats are being offered.";
    case "CLUB_LIMIT":
      return "Your club is at this class's limit, so a seat will go to the next youth. They keep their place.";
  }
}
