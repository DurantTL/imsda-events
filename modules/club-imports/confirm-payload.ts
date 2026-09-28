import type { ClubImportItem } from "@/modules/club-imports/schemas";

/**
 * What the preview sends when the administrator presses Import (#541): exactly
 * the clubs, invites, and people shown as selected, in the club year chosen on
 * each card. Pure, so "one click imports what the preview shows" is testable
 * without a browser.
 */
export type PreviewDraft = {
  sourceKey: string;
  entryId: string;
  clubYear: string;
  clubName: string;
  churchId: string | null;
  newChurchName: string;
  include: boolean;
  invites: Array<{ include: boolean; role: "DIRECTOR" | "DEPUTY"; name: string; email: string }>;
  people: Array<{
    include: boolean;
    firstName: string;
    lastName: string;
    attendeeType: "STAFF" | "YOUTH";
    role: string;
    classLevel: ClubImportItem["people"][number]["classLevel"];
    reportedAge: number | null;
    keepBoth: boolean;
  }>;
};

export function confirmPayload(drafts: PreviewDraft[]) {
  return {
    clubs: drafts.filter((draft) => draft.include).map((draft) => ({
      sourceKey: draft.sourceKey,
      entryId: draft.entryId,
      clubYear: draft.clubYear,
      clubName: draft.clubName,
      churchId: draft.churchId,
      newChurchName: draft.churchId ? "" : draft.newChurchName,
      invites: draft.invites.filter((invite) => invite.include && invite.email).map(({ role, name, email }) => ({ role, name, email })),
      people: draft.people.filter((person) => person.include).map((person) => ({
        firstName: person.firstName,
        lastName: person.lastName,
        attendeeType: person.attendeeType,
        role: person.role,
        classLevel: person.classLevel,
        reportedAge: person.reportedAge,
        keepBoth: person.keepBoth,
      })),
    })),
  };
}
