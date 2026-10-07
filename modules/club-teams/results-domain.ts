import { z } from "zod";
import { TEAM_LEVELS, teamLevelLabels, type TeamLevel } from "@/modules/club-teams/domain";

/**
 * A team's result at each level of a multi-level event (#809): free-text placement or score, whether it qualified for
 * the next level, and a note. Pure, so the staff page, the director's read-only view, the CSV and the tests agree.
 */

export const teamResultInputSchema = z.object({
  level: z.enum(TEAM_LEVELS),
  placement: z.string().trim().max(200, "Keep the placement or score to 200 characters or fewer.").default(""),
  qualified: z.boolean().default(false),
  notes: z.string().trim().max(2000, "Keep the notes to 2,000 characters or fewer.").default(""),
}).strict();

export type TeamResultInput = z.infer<typeof teamResultInputSchema>;

export type TeamResultView = {
  level: TeamLevel;
  placement: string;
  qualified: boolean;
  notes: string;
  updatedAt: string;
};

/** A result with nothing in it: no placement, not qualified, no note. Saving one clears the level instead of storing it. */
export function resultIsBlank(input: Pick<TeamResultInput, "placement" | "qualified" | "notes">) {
  return input.placement === "" && !input.qualified && input.notes === "";
}

/** One team in the results report, with a result (or none) for each level. */
export type TeamResultsRow = {
  clubEventRegistrationId: string;
  teamName: string;
  clubName: string;
  church: string | null;
  confirmationCode: string;
  status: string;
  locationName: string | null;
  /** Team members of 18 or older still waiting for the Area Coordinator's permission (#809). */
  permissionsPending: number;
  results: Record<TeamLevel, TeamResultView | null>;
};

export const emptyResults = (): Record<TeamLevel, TeamResultView | null> => ({ AREA: null, CONFERENCE: null, UNION: null });

/** "Qualified", "Not qualified", or blank when nothing was entered for the level. */
export function qualifiedLabel(result: TeamResultView | null) {
  if (!result) return "";
  return result.qualified ? "Qualified" : "Not qualified";
}

/** The results CSV: one row per team, with placement, qualified and notes for each level. */
export function teamResultsCsvRows(rows: readonly TeamResultsRow[]): Array<Array<string | number>> {
  const table: Array<Array<string | number>> = [[
    "Team", "Club", "Church", "Confirmation", "Location", "AC permission pending",
    ...TEAM_LEVELS.flatMap((level) => [`${teamLevelLabels[level]} placement`, `${teamLevelLabels[level]} qualified`, `${teamLevelLabels[level]} notes`]),
  ]];
  for (const row of rows) {
    table.push([
      row.teamName,
      row.clubName,
      row.church ?? "",
      row.confirmationCode,
      row.locationName ?? "",
      row.permissionsPending,
      ...TEAM_LEVELS.flatMap((level) => {
        const result = row.results[level];
        return [result?.placement ?? "", result ? (result.qualified ? "Yes" : "No") : "", result?.notes ?? ""];
      }),
    ]);
  }
  return table;
}

/** Whether a team qualified for the level after this one: the next level's entry is expected only when it did. */
export function nextLevel(level: TeamLevel): TeamLevel | null {
  const index = TEAM_LEVELS.indexOf(level);
  return TEAM_LEVELS[index + 1] ?? null;
}
