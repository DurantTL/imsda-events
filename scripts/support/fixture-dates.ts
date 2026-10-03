/**
 * Dates for throwaway verification fixtures, always relative to now so a
 * fixture never ages into a closed or past event (a hardcoded date made the
 * public capacity race return 410/410 once it passed). The default window
 * opens a month and a half out and lasts two days.
 */
const dayMs = 24 * 60 * 60 * 1000;

/** `days` from now (negative for the past), at a fixed 21:00 UTC time of day. */
export function daysFromNow(days: number, now: Date = new Date()) {
  const date = new Date(now.getTime() + days * dayMs);
  date.setUTCHours(21, 0, 0, 0);
  return date;
}

/** A future event window: starts `startsInDays` from now and lasts `lengthInDays`. */
export function futureEventWindow(startsInDays = 45, lengthInDays = 2, now: Date = new Date()) {
  const startsAt = daysFromNow(startsInDays, now);
  return { startsAt, endsAt: new Date(startsAt.getTime() + lengthInDays * dayMs) };
}
