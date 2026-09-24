import "server-only";

import {
  type AttendeePassLookup,
  resolveAttendeePassForEvent,
} from "@/modules/checkin/attendee-pass-repository";
import { clubPassTokenPrefix } from "@/modules/checkin/club-pass-token";
import { resolveClubPassForEvent } from "@/modules/checkin/club-pass-repository";

/**
 * The single entry point the scan/lookup route calls (Q1, #412): an
 * attendee pass, a club pass, and a confirmation code all resolve here. A
 * club pass is told apart by its own token prefix before verification ever
 * runs, so it is routed to the club resolver rather than attempted as an
 * attendee pass.
 */
export async function resolvePassLookupForEvent(
  eventId: string,
  lookup: AttendeePassLookup,
  now = new Date(),
) {
  if (lookup.kind === "pass" && lookup.value.trim().startsWith(`${clubPassTokenPrefix}.`)) {
    return resolveClubPassForEvent(eventId, lookup.value.trim(), now);
  }
  return resolveAttendeePassForEvent(eventId, lookup, now);
}
