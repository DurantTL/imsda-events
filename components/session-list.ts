/** How many signed-in devices the Profile page lists before "Show all" (#741). */
export const visibleSessionLimit = 5;

/**
 * The devices to list: all of them when expanded, otherwise the first five with
 * this device always among them (it is moved to the front if the list put it
 * later), so a person never has to expand to find where they are signed in now.
 */
export function visibleSessions<T extends { isCurrent: boolean }>(
  sessions: readonly T[],
  showAll: boolean,
  limit = visibleSessionLimit,
): T[] {
  if (showAll || sessions.length <= limit) return [...sessions];
  const current = sessions.find((session) => session.isCurrent);
  const head = sessions.slice(0, limit);
  if (!current || head.includes(current)) return head;
  return [current, ...head.slice(0, limit - 1)];
}
