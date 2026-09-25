import "server-only";

import { cookies } from "next/headers";
import { LAST_USED_EVENT_COOKIE_NAME } from "@/modules/events/last-used-event-cookie";

/**
 * Reads the event id remembered from a previous visit, if any. Used only to
 * pick a default in `resolveLoginDestination` — never to authorize anything
 * on its own (see `last-used-event-cookie.ts`).
 */
export async function readLastUsedEventId(): Promise<string | null> {
  return (await cookies()).get(LAST_USED_EVENT_COOKIE_NAME)?.value ?? null;
}
