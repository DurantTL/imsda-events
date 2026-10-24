import { z } from "zod";
import { parseAlertRecipients } from "@/modules/club-forms/alert-recipients";
import { describeYouth, type LoggedClassChange } from "@/modules/honors/class-change-domain";

/**
 * Honor watches (#1099): staff name a few addresses to be told, once a day, which youth joined or left classes that teach
 * chosen honors (or chosen classes). Pure rules, with no server-only import, so the setup panel (a client component), the
 * route and the tests share one set of limits, one matching rule and one wording.
 *
 * A watch holds no youth data: its name, addresses and the honor and class ids staff chose. The summary is built from the
 * `HonorClassChange` log (#1098) when it is sent, and names a youth by name, club and age only: never a birth date.
 */

/** Owner decision (Caleb, Oct 20, 2026): 20 watches per event, 10 addresses each. */
export const HONOR_WATCHES_MAX_PER_EVENT = 20;
export const HONOR_WATCH_MAX_RECIPIENTS = 10;
/** A sanity limit on what one watch may list, honors and classes together. */
export const HONOR_WATCH_MAX_TARGETS = 100;

const idList = z.array(z.string().trim().min(1).max(64)).max(HONOR_WATCH_MAX_TARGETS);

export const honorWatchInputSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(2, "Give every watch a name.").max(80, "A watch's name is at most 80 characters."),
  recipients: z.array(z.string().max(200)).max(50),
  honorIds: idList,
  offeringIds: idList,
}).strict();

export const honorWatchesPutSchema = z.object({
  watches: z.array(honorWatchInputSchema).max(HONOR_WATCHES_MAX_PER_EVENT, `An event has at most ${HONOR_WATCHES_MAX_PER_EVENT} honor watches.`),
}).strict();

export type HonorWatchInput = z.infer<typeof honorWatchInputSchema>;

/** A watch as staff see it. */
export type HonorWatchConfig = {
  id: string;
  name: string;
  recipients: string[];
  honorIds: string[];
  offeringIds: string[];
};

export function checkWatchRecipients(raw: readonly string[], stored: readonly string[] = []): { ok: true; emails: string[] } | { ok: false; message: string } {
  // `stored` is the addresses already saved on this watch (#1193): an old one left alone passes.
  const result = parseAlertRecipients([...raw], stored);
  if (!result.ok) return result;
  if (result.emails.length === 0) return { ok: false, message: "Add at least one email address." };
  if (result.emails.length > HONOR_WATCH_MAX_RECIPIENTS) return { ok: false, message: `Add at most ${HONOR_WATCH_MAX_RECIPIENTS} addresses.` };
  return result;
}

/** The same set, ignoring order and repeats: used to tell whether a save changed what a watch looks at. */
export function sameIdSet(a: readonly string[], b: readonly string[]) {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * Whether a class is one the watch looks at: it is a chosen class, or it teaches ANY chosen honor. A class that teaches several
 * honors (#812) matches through each of them, so a youth who picks a class teaching Birds + Knots is reported to a watch on either.
 */
export function watchMatchesClass(watch: { honorIds: readonly string[]; offeringIds: readonly string[] }, offering: { id: string; honorIds: readonly string[] }) {
  if (watch.offeringIds.includes(offering.id)) return true;
  return offering.honorIds.some((honorId) => watch.honorIds.includes(honorId));
}

/**
 * The window a watch's next summary covers, as (since, until]. `since` is the later of the watch's last summary point and the
 * moment it was created, so a new watch never reports what happened before it existed. The summary point moves to `until` on every
 * day the watch is due, so a window is about a day long and always sits inside the log's eight-day retention
 * (`CLASS_CHANGE_RETENTION_DAYS`): a pruned row can only be one that no window still needs.
 */
export function watchWindow(watch: { summaryAt: Date | null; createdAt: Date }, until: Date) {
  return { since: new Date(Math.max(watch.summaryAt?.getTime() ?? 0, watch.createdAt.getTime())), until };
}

/** One summary per watch, per address, per Central date: a second sweep reuses the message instead of sending twice. */
export function honorWatchIdempotencyKey(watchId: string, dateKey: string, email: string) {
  return `honor-watch-summary:${watchId}:${dateKey}:${email}`;
}

export type WatchSummaryPerson = Pick<LoggedClassChange, "youthName" | "clubName" | "ageOnEventDate">;

export type WatchSummaryClass = {
  offeringId: string;
  className: string;
  session: string;
  joined: WatchSummaryPerson[];
  left: WatchSummaryPerson[];
};

export function buildHonorWatchSummary(input: { watchName: string; eventName: string; classes: readonly WatchSummaryClass[] }) {
  const joined = input.classes.reduce((sum, entry) => sum + entry.joined.length, 0);
  const left = input.classes.reduce((sum, entry) => sum + entry.left.length, 0);
  const blocks = input.classes.map((entry) => {
    const lines = [`${entry.className} (${entry.session})`];
    for (const person of entry.joined) lines.push(`  Joined: ${describeYouth(person)}`);
    for (const person of entry.left) lines.push(`  Left: ${describeYouth(person)}`);
    return lines.join("\n");
  });
  return {
    subject: `Honor watch "${input.watchName}" at ${input.eventName}`,
    changes: joined + left,
    joined,
    left,
    bodyText: [
      "Hello,",
      "",
      `Here is what changed since the last summary for the honor watch "${input.watchName}" at ${input.eventName}: ${joined} joined, ${left} left.`,
      "",
      blocks.join("\n\n"),
      "",
      "You are getting this because your address is on this honor watch. To change who is told, ask an event administrator.",
      "",
      "IMSDA Events",
    ].join("\n"),
  };
}
