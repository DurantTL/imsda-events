/**
 * The daily location waitlist digest (#599): pure rules, so the schedule and
 * the wording are testable without a database.
 *
 * Area Coordinators and event staff get one email a day, in the morning
 * Central time, covering everything that changed on the waitlists they are
 * responsible for since the last digest. Nothing is sent on a day with no
 * changes. The club director's own emails are not part of this: they stay
 * immediate.
 */

export const digestTimeZone = "America/Chicago";
/** Local hour (Central) from which the day's digest may be sent. */
export const digestSendHour = 7;

function zonedParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}

/** The calendar date ("YYYY-MM-DD") it is in Central time at `instant`. */
export function centralDateKey(instant: Date) {
  const { year, month, day } = zonedParts(instant, digestTimeZone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The instant a Central wall-clock time falls on: `hour:00` on the calendar date `dateKey`. */
export function centralInstant(dateKey: string, hour: number) {
  const [year, month, day] = dateKey.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, 0, 0);
  let guess = wall;
  // The offset depends on the instant, so settle it in two passes.
  for (let pass = 0; pass < 2; pass += 1) {
    const local = zonedParts(new Date(guess), digestTimeZone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    guess -= localAsUtc - wall;
  }
  return new Date(guess);
}

export type DigestWindow = {
  /** The Central calendar date this digest belongs to; one digest per recipient per date. */
  dateKey: string;
  /** When today's digest becomes due. Changes from before this moment go in it; later ones wait for tomorrow's. */
  sendAt: Date;
  due: boolean;
};

export function digestWindow(now: Date): DigestWindow {
  const dateKey = centralDateKey(now);
  const sendAt = centralInstant(dateKey, digestSendHour);
  return { dateKey, sendAt, due: now.getTime() >= sendAt.getTime() };
}

/** One message per recipient per Central date: a retry or a second run reuses it instead of sending twice. */
export function digestIdempotencyPrefix(dateKey: string) {
  return `location-waitlist-digest:${dateKey}:`;
}

export function digestIdempotencyKey(dateKey: string, recipientEmail: string) {
  return `${digestIdempotencyPrefix(dateKey)}${recipientEmail.trim().toLowerCase()}`;
}

export type DigestChange = {
  kind: "JOINED" | "PROMOTED" | "REMOVED";
  clubName: string;
  attendeeCount: number;
  place: number | null;
  occurredAt: Date;
};

export type DigestLocationSection = { locationName: string; changes: DigestChange[] };
export type DigestEventSection = { eventName: string; locations: DigestLocationSection[] };

const kindLabels: Record<DigestChange["kind"], string> = {
  JOINED: "Joined the waitlist",
  PROMOTED: "Promoted to a registration",
  REMOVED: "Removed from the waitlist",
};

function people(count: number) {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

function changeLine(change: DigestChange) {
  const time = new Intl.DateTimeFormat("en-US", { timeZone: digestTimeZone, hour: "numeric", minute: "2-digit" }).format(change.occurredAt);
  const place = change.place === null
    ? ""
    : change.kind === "JOINED"
      ? `, place #${change.place} in line`
      : `, was place #${change.place} in line`;
  return `  - ${kindLabels[change.kind]}: ${change.clubName} (${people(change.attendeeCount)}${place}) at ${time} Central`;
}

export function digestCount(sections: readonly DigestEventSection[]) {
  return sections.reduce((total, event) => total + event.locations.reduce((sum, location) => sum + location.changes.length, 0), 0);
}

/**
 * The digest email. Plain text only: it is a one-off operational notice to a
 * named coordinator or staff member, not an attendee mailing. Everything a
 * recipient is responsible for is in this one message.
 */
export function buildLocationWaitlistDigest(input: {
  recipientName: string;
  dateKey: string;
  sections: readonly DigestEventSection[];
  reason: "COORDINATOR" | "STAFF" | "BOTH";
}) {
  const total = digestCount(input.sections);
  const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "long" }).format(new Date(`${input.dateKey}T12:00:00.000Z`));
  const subject = `Location waitlist changes: ${total} ${total === 1 ? "update" : "updates"} (${dateLabel})`;
  const lines: string[] = [
    `Hello ${input.recipientName.trim() || "there"},`,
    "",
    "Here is what changed on location waitlists since the last daily digest.",
    "",
  ];
  for (const event of input.sections) {
    lines.push(event.eventName);
    for (const location of event.locations) {
      lines.push(`${location.locationName}`);
      for (const change of location.changes) lines.push(changeLine(change));
    }
    lines.push("");
  }
  const why = input.reason === "COORDINATOR"
    ? "You are receiving this as the Area Coordinator for these locations."
    : input.reason === "STAFF"
      ? "You are receiving this as an event administrator for these events."
      : "You are receiving this as an Area Coordinator and an event administrator for these events.";
  lines.push(why, "This digest is sent once a day, and only on days with changes. Clubs' own waitlist emails are sent right away.");
  return { subject, bodyText: lines.join("\n") };
}
