export type ClubTeamErrorCode =
  | "EVENT_NOT_FOUND"
  | "NOT_A_CLUB_EVENT"
  | "TEAMS_IN_USE"
  | "REGISTRATIONS_WITHOUT_TEAM"
  | "CLASSES_NOT_SUPPORTED"
  | "TEAM_NAME_TAKEN"
  | "TEAM_NAME_INVALID"
  | "TEAM_RULES"
  | "RESULT_INVALID"
  | "REGISTRATION_NOT_FOUND";

/** Every refusal the club teams module can make (#809). Free of server-only imports so any layer can catch it. */
export class ClubTeamError extends Error {
  constructor(
    public readonly code: ClubTeamErrorCode,
    message: string,
    /** Per person or per field detail a screen can show beside the message. */
    public readonly problems: readonly string[] = [],
  ) {
    super(message);
    this.name = "ClubTeamError";
  }
}

export function clubTeamErrorStatus(code: ClubTeamErrorCode) {
  switch (code) {
    case "EVENT_NOT_FOUND":
    case "REGISTRATION_NOT_FOUND":
      return 404;
    case "TEAM_NAME_INVALID":
    case "TEAM_RULES":
    case "RESULT_INVALID":
      return 422;
    default:
      return 409;
  }
}
