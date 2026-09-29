import "server-only";

import { cookies } from "next/headers";
import {
  isEventIdFormat,
  LAST_USED_EVENT_COOKIE_NAME,
} from "@/modules/events/last-used-event-cookie";

/**
 * Reads the event id remembered from a previous visit, if any. A value that is
 * not shaped like an event id is ignored. Used to pick the current event
 * when a page has no `?event=` and the default at sign-in — never to
 * authorize anything on its own (see `last-used-event-cookie.ts`).
 */
export async function readLastUsedEventId(): Promise<string | null> {
  const value = (await cookies()).get(LAST_USED_EVENT_COOKIE_NAME)?.value;
  return isEventIdFormat(value) ? value : null;
}
