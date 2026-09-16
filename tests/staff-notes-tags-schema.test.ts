import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("staff notes, tags, and flags persistence", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync(
    "prisma/migrations/20260916100000_staff_notes_tags_flags/migration.sql",
    "utf8",
  );

  it("keeps a note's body only in append-only revisions, never on the note itself", () => {
    expect(schema).toContain("model StaffNote {");
    expect(schema).toContain("model StaffNoteRevision {");
    expect(schema).toContain("body         String");
    // The note model carries no body/text column of its own.
    const noteModel = schema.slice(schema.indexOf("model StaffNote {"), schema.indexOf("model StaffNoteRevision {"));
    expect(noteModel).not.toMatch(/\bbody\s+String/);
  });

  it("enforces exactly one note subject and a required restricted permission in the database, not only the app", () => {
    expect(migration).toContain("StaffNote_single_subject_check");
    expect(migration).toContain("StaffNote_restricted_permission_check");
  });

  it("preserves tag-assignment history on removal instead of deleting the row", () => {
    expect(schema).toContain("model RegistrationTagAssignment {");
    expect(schema).toContain("model AttendeeTagAssignment {");
    expect(schema).toContain("removedByUserId String?");
    expect(schema).toContain("removedAt       DateTime?");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"RegistrationTagAssignment"/i);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"AttendeeTagAssignment"/i);
  });

  it("has no flag table or column anywhere in the schema — flags are computed, never stored", () => {
    expect(schema).not.toMatch(/model\s+\w*Flag\w*\s*\{/i);
    expect(schema).not.toMatch(/^\s*flags?\s+/im);
  });

  it("guards tag and note references against crossing event boundaries", () => {
    expect(migration).toContain("tag belongs to another event");
    expect(migration).toContain("registration belongs to another event");
    expect(migration).toContain("attendee belongs to another event");
  });

  it("configures tags as one vocabulary per event, not free text", () => {
    expect(schema).toContain("model EventTag {");
    expect(schema).toContain("@@unique([eventId, normalizedName])");
  });
});
