import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClubImportWorkspace, loadPreviewDrafts, type ClubImportPreview } from "@/components/club-import-workspace";
import { parseClubRegistrationExport, type ImportedYears } from "@/modules/club-imports/domain";
import type { AnnotatedImportDraft } from "@/modules/club-imports/repository";
import { syntheticExportEntry } from "./support/club-import-fixture";

/**
 * The club import preview right after an upload (#541), rendered without a
 * DOM: what the administrator sees before touching anything.
 */

const now = new Date("2026-09-28T15:00:00Z");

function preview(importedYears: ImportedYears = {}, response: Record<string, unknown> = {}): ClubImportPreview {
  const [draft] = parseClubRegistrationExport([syntheticExportEntry({}, response)], now).drafts;
  const annotated: AnnotatedImportDraft = { ...draft, churchId: null, newChurchName: draft.churchName, importedYears, existingClub: null };
  return { drafts: [annotated], churches: [], clubYearChoices: ["2025-26", "2026-27", "2027-28"], skipped: 0 };
}

const render = (initialPreview: ClubImportPreview) => renderToStaticMarkup(createElement(ClubImportWorkspace, { initialPreview }));
/** The opening tag of the "Import N clubs" button. */
const importButton = (html: string) => /<button[^>]*>(?:(?!<\/button>).)*Import \d+ clubs?<\/button>/.exec(html)?.[0].split(">")[0] ?? "";
const clubCheckbox = (html: string) => /<input aria-label="Import Fixture Hills Pathfinders"[^>]*>/.exec(html)?.[0] ?? "";

describe("the club import preview after upload (#541)", () => {
  it("selects a new entry, so one click imports it", () => {
    const html = render(preview());
    expect(clubCheckbox(html)).toMatch(/checked=""/);
    expect(html).toContain("Import 1 club");
    expect(importButton(html)).toMatch(/primary-button/);
    expect(importButton(html)).not.toContain("disabled");
    expect(html).not.toContain("Move import to another year");
  });

  it("shows the year choice, set to the current year, with the submission note", () => {
    const html = render(preview());
    expect(html).toContain("Club year to import into");
    expect(html).toMatch(/aria-label="Club year for Fixture Hills Pathfinders"/);
    for (const year of ["2025-26", "2026-27", "2027-28"]) expect(html).toContain(`<option value="${year}"`);
    expect(html).toMatch(/<option value="2026-27" selected="">/);
    expect(html).toContain("Submitted 2026-08-31, which falls in the 2025-26 club year. Importing into 2026-27.");
  });

  it("leaves a re-upload of an entry imported for the chosen year unselected, pointing to Move", () => {
    const html = render(preview({ "2026-27": { id: "club-9", name: "Fixture Hills Pathfinders" } }));
    expect(clubCheckbox(html)).not.toMatch(/checked=""/);
    expect(html).toContain("Import 0 clubs");
    expect(importButton(html)).toContain("disabled");
    expect(html).toContain("Already imported for 2026-27. To fix the year, use Move import to another year.");
    expect(html).not.toMatch(/import it again/i);
    expect(html).toContain('href="/admin/organizations/club-9/club#club-import-year"');
  });

  it("leaves an entry imported for another year unselected and suggests Move instead of importing again", () => {
    const html = render(preview({ "2025-26": { id: "club-9", name: "Fixture Hills Pathfinders" } }));
    expect(clubCheckbox(html)).not.toMatch(/checked=""/);
    expect(html).toContain("Already imported for 2025-26. Importing it again for 2026-27 would add everyone a second time. To fix the year, use Move import to another year instead.");
    expect(html).toContain('href="/admin/organizations/club-9/club#club-import-year"');
    const [draft] = loadPreviewDrafts(preview({ "2025-26": { id: "club-9", name: "x" } }).drafts);
    expect(draft).toMatchObject({ include: false, expanded: true });
  });

  it("shows the first and last name split, with a suffix kept on the last name", () => {
    const html = render(preview({}, { leader_name: "Chris Faux Jr." }));
    expect(html).toMatch(/aria-label="First name"[^>]*value="Chris"/);
    expect(html).toMatch(/aria-label="Last name"[^>]*value="Faux Jr\."/);
  });

  it("flags a same-named person in the same section, with a Keep both choice", () => {
    const html = render(preview({}, { repeater_container: [["Robin Faux", "9", "Friend"], ["Robin Faux", "12", "Explorer"]] }));
    expect(html).toContain("1 person has the same name and section as");
    expect((html.match(/Keep both people named Robin Faux/g) ?? []).length).toBe(1);
  });
});
