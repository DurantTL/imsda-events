/**
 * Club home's "Next task" (#743): the first thing on the club's to-do list and
 * its deadline, shown before the statistics. The list and its order are the
 * ones Club home already built ("What's next"); this only picks the first and
 * words its deadline. Nothing here reads data or changes the club menu.
 */

export type ClubHomeStep = { key: string; text: string; href: string; action: string; danger?: boolean };

export type ClubNextTask = {
  step: ClubHomeStep;
  /** E.g. "Due June 15" or "Register by September 12, 2027"; null when the task has no deadline. */
  deadline: string | null;
  /** Every other step, still in the list below the statistics. */
  others: ClubHomeStep[];
};

/** `deadlines` maps a step's key to its already-worded deadline (report due dates, event closing dates). */
export function pickClubNextTask(steps: readonly ClubHomeStep[], deadlines: Readonly<Record<string, string>>): ClubNextTask | null {
  const [step, ...others] = steps;
  if (!step) return null;
  return { step, deadline: deadlines[step.key] ?? null, others };
}
