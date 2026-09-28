import { describe, expect, it } from "vitest";
import { confirmPayload, type PreviewDraft } from "@/modules/club-imports/confirm-payload";
import { parseClubRegistrationExport } from "@/modules/club-imports/domain";
import { clubImportConfirmSchema } from "@/modules/club-imports/schemas";
import { syntheticExportEntry } from "./support/club-import-fixture";

// The preview state right after the file loads, with no clicks (#541).
function loadedPreview(): PreviewDraft[] {
  const { drafts } = parseClubRegistrationExport([syntheticExportEntry()], new Date("2026-09-28T15:00:00Z"));
  return drafts.map((draft) => ({ ...draft, churchId: null, newChurchName: draft.churchName, include: true }));
}

describe("what Import sends (#541)", () => {
  it("sends the whole selected club, in the current year, with no extra click", () => {
    const payload = clubImportConfirmSchema.parse(confirmPayload(loadedPreview()));
    expect(payload.clubs).toHaveLength(1);
    const [club] = payload.clubs;
    expect(club.clubYear).toBe("2026-27");
    expect(club.people).toHaveLength(48);
    expect(club.invites.map((invite) => invite.role)).toEqual(["DIRECTOR", "DEPUTY"]);
    expect(club.newChurchName).toBe("Fixture Hills SDA Church");
  });

  it("sends the year picked on the card", () => {
    const preview = loadedPreview().map((draft) => ({ ...draft, clubYear: "2025-26" }));
    expect(clubImportConfirmSchema.parse(confirmPayload(preview)).clubs[0].clubYear).toBe("2025-26");
  });

  it("sends nothing for an unselected club, and only the people ticked", () => {
    const preview = loadedPreview();
    expect(confirmPayload(preview.map((draft) => ({ ...draft, include: false }))).clubs).toEqual([]);
    preview[0].people[3].include = false;
    expect(confirmPayload(preview).clubs[0].people).toHaveLength(47);
  });
});
