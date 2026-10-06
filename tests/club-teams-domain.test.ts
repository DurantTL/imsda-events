import { describe, expect, it } from "vitest";
import {
  NO_TEAM_KEY,
  cleanTeamName,
  draftKeySchema,
  levelInfoFromJson,
  normalizeTeamName,
  resolveTeamName,
  teamLabel,
  teamNameIsTaken,
  teamNameSchema,
  teamNameTakenMessage,
  teamSettingsInputSchema,
} from "@/modules/club-teams/domain";
import { assignmentKey } from "@/modules/reporting/club-event-reports";
import { assignmentRecipientKey } from "@/modules/communications/club-assignment-audience";

describe("team names (#809)", () => {
  it("treats names that differ only in case, spacing or composed letters as the same team", () => {
    expect(normalizeTeamName("  Bible   Bees ")).toBe("bible bees");
    expect(normalizeTeamName("BIBLE BEES")).toBe(normalizeTeamName("bible bees"));
    expect(normalizeTeamName("Café Crew")).toBe(normalizeTeamName("Café Crew"));
    expect(normalizeTeamName("Team A")).not.toBe(normalizeTeamName("Team B"));
  });

  it("keeps the director's own capitals when it cleans a name for display", () => {
    expect(cleanTeamName("  Bible   Bees ")).toBe("Bible Bees");
  });

  it("requires a name, caps its length, and refuses control characters", () => {
    expect(teamNameSchema.safeParse("   ").success).toBe(false);
    expect(teamNameSchema.safeParse("x".repeat(81)).success).toBe(false);
    expect(teamNameSchema.safeParse("x".repeat(80)).success).toBe(true);
    expect(teamNameSchema.safeParse("Bad\u0007Name").success).toBe(false);
    expect(teamNameSchema.parse("  Sword   Drill ")).toBe("Sword Drill");
  });

  it("finds a name already taken among the event's keys, and words the refusal without naming another club", () => {
    expect(teamNameIsTaken("BIBLE bees", ["other team", "bible bees"])).toBe(true);
    expect(teamNameIsTaken("Fresh Name", ["bible bees"])).toBe(false);
    expect(teamNameTakenMessage("Bible Bees")).toBe('A team named "Bible Bees" is already registered for this event. Choose a different team name.');
  });

  it("labels a team with its club, and a club registration with its club alone", () => {
    expect(teamLabel("Test Pathfinders", "Bible Bees")).toBe("Bible Bees (Test Pathfinders)");
    expect(teamLabel("Test Pathfinders", null)).toBe("Test Pathfinders");
    expect(teamLabel("Test Pathfinders", "")).toBe("Test Pathfinders");
  });

  it("keys a draft by an id the page picked, never by the team name", () => {
    expect(draftKeySchema.safeParse("a1b2c3d4e5f60718").success).toBe(true);
    expect(draftKeySchema.safeParse("short").success).toBe(false);
    expect(draftKeySchema.safeParse("has spaces in it!").success).toBe(false);
  });
});

describe("resolving the team a request names (#809)", () => {
  it("gives an event without team settings the empty key, as every club registration had before", () => {
    expect(resolveTeamName(null, undefined)).toEqual({ ok: true, teamName: null, teamKey: NO_TEAM_KEY });
    expect(resolveTeamName(null, null)).toEqual({ ok: true, teamName: null, teamKey: NO_TEAM_KEY });
    expect(resolveTeamName({ allowMultipleTeams: false }, "")).toEqual({ ok: true, teamName: null, teamKey: NO_TEAM_KEY });
  });

  it("refuses a team name on an event that takes one registration per club", () => {
    expect(resolveTeamName(null, "Bible Bees")).toEqual({ ok: false, message: "This event takes one registration per club, so it has no team name." });
    expect(resolveTeamName({ allowMultipleTeams: false }, "Bible Bees")).toMatchObject({ ok: false });
  });

  it("requires a name when several teams are allowed, and returns the cleaned name with its key", () => {
    expect(resolveTeamName({ allowMultipleTeams: true }, undefined)).toEqual({ ok: false, message: "Enter a name for the team." });
    expect(resolveTeamName({ allowMultipleTeams: true }, "   ")).toMatchObject({ ok: false });
    expect(resolveTeamName({ allowMultipleTeams: true }, " Bible   Bees ")).toEqual({ ok: true, teamName: "Bible Bees", teamKey: "bible bees" });
  });
});

describe("team settings (#809)", () => {
  it("accepts the Pathfinder Bible Experience rules", () => {
    const parsed = teamSettingsInputSchema.parse({
      allowMultipleTeams: true,
      minTeamMembers: 2,
      maxTeamMembers: 7,
      maxAlternates: 1,
      ageAsOf: "2026-01-01",
      maxMemberAge: 19,
      booksLine: "The Book of Mark, 1-2 Peter, 1-3 John & Commentary",
      levelInfo: [
        { level: "CONFERENCE", date: "2027-02-20", place: "TBA" },
        { level: "UNION", date: "2027-03-27", place: "Lincoln, NE" },
      ],
    });
    expect(parsed).toMatchObject({ allowMultipleTeams: true, minTeamMembers: 2, maxTeamMembers: 7, maxAlternates: 1, ageAsOf: "2026-01-01", maxMemberAge: 19 });
  });

  it("defaults to no teams, no limits, no alternate", () => {
    expect(teamSettingsInputSchema.parse({})).toEqual({
      allowMultipleTeams: false, minTeamMembers: null, maxTeamMembers: null, maxAlternates: 0, ageAsOf: null, maxMemberAge: null, booksLine: "", levelInfo: [],
    });
  });

  it.each([
    [{ minTeamMembers: 5, maxTeamMembers: 3 }, "The fewest team members cannot be more than the most."],
    [{ minTeamMembers: 0 }, "The fewest team members must be at least 1."],
    [{ ageAsOf: "2026-02-30" }, "Enter a valid calendar date."],
    [{ ageAsOf: "January 1" }, "Use a calendar date in YYYY-MM-DD format."],
    [{ maxAlternates: -1 }, "Too small: expected number to be >=0"],
    [{ levelInfo: [{ level: "UNION", date: null, place: "" }, { level: "UNION", date: null, place: "" }] }, "Union is listed twice."],
    [{ levelInfo: [{ level: "AREA", date: null, place: "" }] }, "Invalid option: expected one of \"CONFERENCE\"|\"UNION\""],
  ])("refuses %j", (input, message) => {
    const result = teamSettingsInputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toBe(message);
  });

  it("reads a stored level list defensively", () => {
    expect(levelInfoFromJson([{ level: "UNION", date: "2027-03-27", place: "Lincoln, NE" }])).toEqual([{ level: "UNION", date: "2027-03-27", place: "Lincoln, NE" }]);
    expect(levelInfoFromJson("nonsense")).toEqual([]);
    expect(levelInfoFromJson([{ level: "NOPE" }])).toEqual([]);
  });
});

describe("keys that tell a club's teams apart (#809)", () => {
  it("keeps the club's id as the key for a registration without a team, so existing reports and batches read as before", () => {
    expect(assignmentKey("org-1", "")).toBe("org-1");
    expect(assignmentKey("org-1", undefined)).toBe("org-1");
    expect(assignmentRecipientKey({ organizationId: "org-1" })).toBe("org-1");
    expect(assignmentRecipientKey({ organizationId: "org-1", teamKey: "" })).toBe("org-1");
  });

  it("gives each of a club's teams its own key", () => {
    expect(assignmentKey("org-1", "bible bees")).not.toBe(assignmentKey("org-1", "sword drill"));
    expect(assignmentKey("org-1", "bible bees")).not.toBe("org-1");
    expect(assignmentRecipientKey({ organizationId: "org-1", teamKey: "bible bees" })).not.toBe(assignmentRecipientKey({ organizationId: "org-1", teamKey: "sword drill" }));
  });
});
