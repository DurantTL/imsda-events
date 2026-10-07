import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { areaClubPortalNavItems } from "@/modules/club-rosters/portal-nav";

const read = (file: string) => readFileSync(file, "utf8");

describe("meeting note and monthly report dialogs (#789)", () => {
  const notes = read("components/club-meeting-notes.tsx");
  const report = read("components/club-report-form.tsx");

  it("opens the meeting-note editor in an accessible dialog", () => {
    expect(notes).toContain('import { useAccessibleDialog } from "@/components/use-accessible-dialog"');
    expect(notes).toMatch(/useAccessibleDialog<HTMLElement>\(editorOpen, requestClose\)/);
    expect(notes).toContain('role="dialog"');
    expect(notes).toContain('aria-modal="true"');
    expect(notes).toContain('aria-labelledby="meeting-note-dialog-title"');
    expect(notes).toContain('id="meeting-note-dialog-title"');
    expect(notes).toContain('className="modal-backdrop"');
    // The old inline editor scrolled to the bottom of the page.
    expect(notes).not.toContain("scrollIntoView");
    // Add stays visible so focus can return to it.
    expect(notes).not.toMatch(/\{!formOpen && \(\s*<button className="primary-button" data-meeting-note-add/);
  });

  it("opens the monthly report form in a dialog on the Monthly Records page", () => {
    expect(report).toMatch(/useAccessibleDialog<HTMLElement>\(dialogOpen,/);
    expect(report).toContain('aria-labelledby="monthly-report-dialog-title"');
    expect(report).toContain('role="dialog"');
    expect(report).toContain("data-monthly-report-open");
    expect(read("app/(public)/account/(portal)/clubs/[organizationId]/records/page.tsx")).toMatch(/<ClubReportForm\s+allowDraft\s+asDialog/);
  });

  it("never discards a changed meeting-note draft silently", () => {
    const notes = read("components/club-meeting-notes.tsx");
    expect(notes).toMatch(/useAccessibleDialog<HTMLElement>\(editorOpen, requestClose\)/);
    expect(notes).toContain("Discard this meeting note?");
    expect(notes).toMatch(/if \(dirty\) setConfirmingDiscard\(true\)/);
    // No close-on-backdrop.
    expect(notes).toContain('<div className="modal-backdrop" role="presentation">');
  });

  it("shows the running total inside the report dialog and wraps the page card", () => {
    expect(report).toContain("renderSummary(asDialog)");
    expect(report).toContain("data-report-feedback");
    const css = read("app/globals.css");
    expect(css).toMatch(/\.club-report-total \{ display: flex; flex-wrap: wrap;/);
    expect(css).toContain(".club-report-total.club-report-total-dialog");
  });

  it("pulls focus back into the dialog when Tab is pressed from outside it", () => {
    expect(read("components/use-accessible-dialog.ts")).toMatch(/!dialogElement\.contains\(document\.activeElement\)/);
  });

  it("keeps the dialog form mounted so typed values survive closing it", () => {
    expect(report).toMatch(/style=\{open \? undefined : \{ display: "none" \}\}/);
  });
});

describe("area coordinator tab name (#789)", () => {
  it("calls the records tab Monthly Records, as in the club portal", () => {
    const labels = areaClubPortalNavItems({ organizationId: "club-1" }).map((item) => item.label);
    expect(labels).toContain("Monthly Records");
    expect(labels).not.toContain("Monthly reports");
  });
});

describe("spacing and caption overflow (#789)", () => {
  it("separates helper text from the notice or buttons above it", () => {
    const css = read("components/club-orders.module.css");
    expect(css).toMatch(/:global\(\.inline-notice\) \+ \.helpText:global\(\.field-help\)/);
    expect(css).toMatch(/margin-top:\s*14px/);
  });

  it("keeps a visually hidden table caption out of the card caption rule", () => {
    const css = read("app/globals.css");
    expect(css).toContain("> caption:not(.sr-only)");
    expect(css).not.toMatch(/table\.table-cards\.table-cards > caption \{/);
  });
});

describe("meeting note Saved banner (#810)", () => {
  const notes = read("components/club-meeting-notes.tsx");
  const css = read("app/globals.css");

  it("shows a green Saved banner at the top of the popup after a save, in the report's success style", () => {
    // Same class the monthly report's confirmation uses.
    expect(read("components/club-report-form.tsx")).toContain('className="inline-notice success"');
    expect(notes).toMatch(/justSaved && !dirty && <div className="inline-notice success meeting-note-saved" data-meeting-note-saved="" role="status">Saved<\/div>/);
    // It is the first thing in the dialog's form, before the heading.
    expect(notes.indexOf("data-meeting-note-saved")).toBeLessThan(notes.indexOf('id="meeting-note-dialog-title"'));
  });

  it("keeps the popup open on the saved note and clears the banner when the draft changes again", () => {
    expect(notes).toContain("setJustSaved(true)");
    expect(notes).toMatch(/setEditingId\(result\.note\.id\);\s*setHadAttendance\([^)]*\);\s*setAdding\(false\);\s*setBaseline\(JSON\.stringify\(draft\)\)/);
    expect(notes).toMatch(/justSaved && !dirty/);
    expect(notes.match(/setJustSaved\(false\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("pins the banner while the popup scrolls", () => {
    expect(css).toMatch(/\.meeting-note-saved \{[^}]*position: sticky;[^}]*top: 0;/);
  });
});

describe("meeting note check-off flag after a save (#810)", () => {
  const notes = read("components/club-meeting-notes.tsx");

  it("keeps the saved note's attendance flag in state, not a lookup in the month's list", () => {
    expect(notes).toContain("setHadAttendance(note.attendance.length > 0)");
    expect(notes).toContain("setHadAttendance(result.note.attendance.length > 0)");
    expect(notes).not.toMatch(/notes\.find\(\(note\) => note\.id === editingId\)/);
  });
});
