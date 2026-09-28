import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
function source(relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

/**
 * #471: no high-consequence action listed in the issue uses `window.confirm()`
 * any more, and each goes through the one shared `ConfirmDialog` (#466)
 * instead of a one-off modal. These are source-level checks — each dialog's
 * accessible markup and busy-guard behavior is already proven once, generically,
 * by tests/confirm-dialog.test.ts; a static render of these particular
 * workspaces can't open the dialog since it only appears after a click.
 */
describe("high-consequence actions use the shared ConfirmDialog, not window.confirm() (#471)", () => {
  const files = [
    "components/check-in-workspace.tsx",
    "components/attendee-accounts-workspace.tsx",
    "components/club-team-workspace.tsx",
    "components/calendar-admin-workspace.tsx",
    "components/registration-amendment-editor.tsx",
  ];

  it.each(files)("%s has no window.confirm() call", (file) => {
    // Excludes comment lines: this file's own doc comments name
    // `window.confirm()` as what was replaced.
    const codeLines = source(file)
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(codeLines.join("\n")).not.toMatch(/window\.confirm\(/);
  });

  it.each(files)("%s imports and renders the shared ConfirmDialog", (file) => {
    const code = source(file);
    expect(code).toContain('import { ConfirmDialog } from "@/components/confirm-dialog"');
    expect(code).toContain("<ConfirmDialog");
  });

  it("check-in-workspace keeps both discard confirmations' exact wording", () => {
    const code = source("components/check-in-workspace.tsx");
    expect(code).toContain("This only removes the retry from this device. It does not undo a server check-in.");
    expect(code).toContain("This cannot undo or change any check-in already received by the server.");
  });

  it("attendee-accounts-workspace keeps the reset/coordinator/sign-out consequences", () => {
    const code = source("components/attendee-accounts-workspace.tsx");
    expect(code).toContain("Their authenticator and passkeys are removed and they're signed out.");
    expect(code).toContain("They'll no longer see other clubs.");
    expect(code).toContain("They'll see every club, view only (ages, not birth dates), after a second sign-in step.");
  });

  it("club-team-workspace still says access is lost right away when removing a member", () => {
    expect(source("components/club-team-workspace.tsx")).toContain("They lose access to this club right away.");
  });

  it("calendar-admin-workspace keeps the can't-be-undone warning", () => {
    expect(source("components/calendar-admin-workspace.tsx")).toContain("This can&apos;t be undone.");
  });

  it("registration-amendment-editor makes clear removing an attendee only edits the draft", () => {
    expect(source("components/registration-amendment-editor.tsx"))
      .toContain("This only changes the draft amendment. Nothing is submitted until you review and confirm it.");
  });
});

/**
 * #471: removals say what disappears and what stays, through the same
 * shared dialog, across every listed removal surface.
 */
describe("removal review dialogs say what's removed and what's kept (#471)", () => {
  it("registration builder shows the real submitted-answer count before removing a field or section", () => {
    const code = source("components/registration-builder-workspace.tsx");
    expect(code).toContain("<ConfirmDialog");
    expect(code).toContain("stay on those registrations");
    expect(code).toContain("/field-answer-counts");
  });

  it("event content workspace explains a removed section only takes effect on save", () => {
    const code = source("components/event-content-workspace.tsx");
    expect(code).toContain("<ConfirmDialog");
    expect(code).toContain("Nothing takes effect until you save");
  });

  it("tag configuration explains deactivation stays visible on tagged records", () => {
    const code = source("components/tag-configuration-workspace.tsx");
    expect(code).toContain("<ConfirmDialog");
    expect(code).toContain("stays visible, unchanged, on every");
  });

  it("merchandise admin explains archiving preserves order history", () => {
    const code = source("components/merchandise-admin-workspace.tsx");
    expect(code).toContain("<ConfirmDialog");
    expect(code).toContain("existing orders and order history are preserved");
  });
});
