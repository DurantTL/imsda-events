import { z } from "zod";

/**
 * Club teams (#809): an event may let a club register more than one team, each
 * with its own name (the Pathfinder Bible Experience). Pure rules, so the
 * director's page, the server and the tests agree on what a name is, when two
 * names are the same, and what a team setting may hold.
 *
 * An event without team settings (or with `allowMultipleTeams` off) is a club
 * event as it has always been: one registration per club, the empty team key.
 */

/** The key of a club's one registration on an event without teams. Every registration made before #809 has it. */
export const NO_TEAM_KEY = "";

export const TEAM_NAME_MAX = 80;

/**
 * Case-insensitive, whitespace-collapsed identity of a team name, so "Bible  Bees"
 * and "bible bees" are the same team. The key stored on a registration and the one
 * the event-wide unique index is built on.
 */
export function normalizeTeamName(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

/** The team name as it is kept and shown: trimmed, spacing collapsed, the director's own capitals. */
export function cleanTeamName(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ");
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const teamNameSchema = z.string()
  .transform(cleanTeamName)
  .pipe(
    z.string()
      .min(1, "Enter a name for the team.")
      .max(TEAM_NAME_MAX, `Keep the team name to ${TEAM_NAME_MAX} characters or fewer.`)
      .refine((value) => !CONTROL_CHARACTERS.test(value), "The team name can only use letters, numbers and punctuation."),
  );

/** What an event-wide name clash says. Never names the other club. */
export function teamNameTakenMessage(teamName: string) {
  return `A team named "${teamName}" is already registered for this event. Choose a different team name.`;
}

/** Whether a name is already used by another registration, among the names an event holds. */
export function teamNameIsTaken(teamName: string, existingKeys: Iterable<string>) {
  const key = normalizeTeamName(teamName);
  for (const existing of existingKeys) if (existing === key) return true;
  return false;
}

/**
 * The identifier of one of a club's unsubmitted drafts (#809): a random id the
 * page picks for each team being registered; `''` on an event without teams.
 * Never the team's key, because the name can change while it is typed.
 */
export const draftKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/, "Refresh the page and start the team again.");

/** How a club's registration is named in lists: the team's name, else the club's. */
export function teamLabel(club: string, teamName: string | null | undefined) {
  return teamName ? `${teamName} (${club})` : club;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export const TEAM_LEVELS = ["AREA", "CONFERENCE", "UNION"] as const;
export type TeamLevel = (typeof TEAM_LEVELS)[number];

export const teamLevelLabels: Record<TeamLevel, string> = {
  AREA: "Area",
  CONFERENCE: "Conference",
  UNION: "Union",
};

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date in YYYY-MM-DD format.").refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "Enter a valid calendar date.");

/** A level above the Area level: its date and where it is held. Both optional while the venue or date is not known yet. */
export const teamLevelInfoSchema = z.object({
  level: z.enum(["CONFERENCE", "UNION"]),
  date: calendarDate.nullable().default(null),
  place: z.string().trim().max(120).default(""),
}).strict();

export type TeamLevelInfo = z.infer<typeof teamLevelInfoSchema>;

const optionalCount = (label: string, maximum: number) => z.number()
  .int(`${label} must be a whole number.`)
  .min(1, `${label} must be at least 1.`)
  .max(maximum, `${label} can be at most ${maximum}.`)
  .nullable();

export const teamSettingsInputSchema = z.object({
  allowMultipleTeams: z.boolean().default(false),
  minTeamMembers: optionalCount("The fewest team members", 100).default(null),
  maxTeamMembers: optionalCount("The most team members", 100).default(null),
  maxAlternates: z.number().int("The most alternates must be a whole number.").min(0).max(10).default(0),
  ageAsOf: calendarDate.nullable().default(null),
  maxMemberAge: z.number().int("The oldest age must be a whole number.").min(0).max(120).nullable().default(null),
  booksLine: z.string().trim().max(300).default(""),
  levelInfo: z.array(teamLevelInfoSchema).max(2).default([]),
}).strict().superRefine((value, context) => {
  if (value.minTeamMembers !== null && value.maxTeamMembers !== null && value.minTeamMembers > value.maxTeamMembers) {
    context.addIssue({ code: "custom", path: ["minTeamMembers"], message: "The fewest team members cannot be more than the most." });
  }
  const levels = new Set<string>();
  value.levelInfo.forEach((entry, index) => {
    if (levels.has(entry.level)) context.addIssue({ code: "custom", path: ["levelInfo", index, "level"], message: `${teamLevelLabels[entry.level]} is listed twice.` });
    levels.add(entry.level);
  });
});

export type TeamSettingsInput = z.infer<typeof teamSettingsInputSchema>;
export type TeamSettingsInputValues = z.input<typeof teamSettingsInputSchema>;

/** The settings an event with teams carries, as the rest of the app reads them. */
export type TeamSettings = {
  allowMultipleTeams: boolean;
  minTeamMembers: number | null;
  maxTeamMembers: number | null;
  maxAlternates: number;
  ageAsOf: string | null;
  maxMemberAge: number | null;
  booksLine: string;
  levelInfo: TeamLevelInfo[];
};

/** A stored `levelInfo` value read defensively: anything that no longer parses is dropped. */
export function levelInfoFromJson(value: unknown): TeamLevelInfo[] {
  const parsed = z.array(teamLevelInfoSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Whether the event runs as one with teams at all (a settings row with something set). */
export function eventUsesTeams(settings: TeamSettings | null): settings is TeamSettings {
  return settings !== null;
}

/** Whether a club registering here names its team and may register several. */
export function eventAllowsMultipleTeams(settings: TeamSettings | null) {
  return settings?.allowMultipleTeams === true;
}

/**
 * The team a request names, against what the event allows: a name is required
 * (and made into a key) when the event has multiple teams on, and refused when it
 * does not, so an event without teams can never gain a named registration.
 */
export function resolveTeamName(
  settings: Pick<TeamSettings, "allowMultipleTeams"> | null,
  requested: string | null | undefined,
): { ok: true; teamName: string | null; teamKey: string } | { ok: false; message: string } {
  if (!settings?.allowMultipleTeams) {
    if (requested && requested.trim()) return { ok: false, message: "This event takes one registration per club, so it has no team name." };
    return { ok: true, teamName: null, teamKey: NO_TEAM_KEY };
  }
  const parsed = teamNameSchema.safeParse(requested ?? "");
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Enter a name for the team." };
  return { ok: true, teamName: parsed.data, teamKey: normalizeTeamName(parsed.data) };
}
