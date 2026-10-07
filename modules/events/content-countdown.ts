/**
 * Countdown maths for the COUNTDOWN block (#816). Pure, so the server render
 * and the client enhancement agree and a test can pin them.
 */

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string) {
  let formatter = wallClockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    wallClockFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallClockAsUtcMs(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    wallClockFormatter(timeZone).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
}

/** `2026-10-09T18:00` read as a wall-clock time in `timeZone`. Null when it is not a date. */
export function zonedLocalToDate(local: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  try {
    // Two passes settle the offset, including across a daylight-saving change.
    for (let pass = 0; pass < 2; pass += 1) {
      guess += wanted - wallClockAsUtcMs(new Date(guess), timeZone);
    }
  } catch {
    return null;
  }
  const result = new Date(guess);
  return Number.isNaN(result.getTime()) ? null : result;
}

export type CountdownPhase = "before" | "during" | "after";

/**
 * Where "now" sits against the target. With an end (the event's own finish),
 * the time between the two is "during"; without one, the target passing is
 * simply "after".
 */
export function countdownPhase(nowMs: number, targetMs: number, endMs: number | null): {
  phase: CountdownPhase;
  remainingMs: number;
} {
  if (nowMs < targetMs) return { phase: "before", remainingMs: targetMs - nowMs };
  if (endMs !== null && nowMs < endMs) return { phase: "during", remainingMs: 0 };
  return { phase: "after", remainingMs: 0 };
}

export function splitRemaining(remainingMs: number) {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

export function formatCountdownTarget(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(date);
}
