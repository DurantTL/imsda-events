import { describe, expect, it } from "vitest";
import {
  canReadNote,
  noteInputSchema,
  noteRevisionInputSchema,
} from "@/modules/notes/domain";

describe("noteInputSchema", () => {
  it("defaults to staff-wide visibility with no restricted permission", () => {
    const parsed = noteInputSchema.parse({ body: "Called her, she is arriving Friday instead." });
    expect(parsed.visibility).toBe("STAFF");
    expect(parsed.restrictedPermission).toBeUndefined();
  });

  it("requires a named permission when a note is restricted", () => {
    expect(() => noteInputSchema.parse({ body: "Sensitive follow-up.", visibility: "RESTRICTED" }))
      .toThrow(/must name the permission/);
  });

  it("rejects a restricted permission on a staff-wide note", () => {
    expect(() => noteInputSchema.parse({
      body: "Should be visible to everyone.",
      visibility: "STAFF",
      restrictedPermission: "MANAGE_FINANCE",
    })).toThrow(/cannot also be restricted/);
  });

  it("accepts a restricted note that names a valid permission", () => {
    const parsed = noteInputSchema.parse({
      body: "Balance dispute, finance only.",
      visibility: "RESTRICTED",
      restrictedPermission: "MANAGE_FINANCE",
    });
    expect(parsed.restrictedPermission).toBe("MANAGE_FINANCE");
  });

  it("rejects an empty body", () => {
    expect(() => noteInputSchema.parse({ body: "   " })).toThrow();
  });
});

describe("noteRevisionInputSchema", () => {
  it("accepts a revised body only", () => {
    expect(noteRevisionInputSchema.parse({ body: "Updated: arriving Saturday, not Friday." }).body)
      .toBe("Updated: arriving Saturday, not Friday.");
  });
});

describe("canReadNote — the rule every read path, including exports, must apply", () => {
  const staffNote = { visibility: "STAFF" as const, restrictedPermission: null };
  const restrictedToFinance = { visibility: "RESTRICTED" as const, restrictedPermission: "MANAGE_FINANCE" };

  it("lets anyone read a staff-wide note", () => {
    expect(canReadNote(staffNote, new Set())).toBe(true);
    expect(canReadNote(staffNote, new Set(["VIEW_REPORTS"]))).toBe(true);
  });

  it("denies a restricted note to someone without the named permission", () => {
    expect(canReadNote(restrictedToFinance, new Set(["VIEW_REPORTS"]))).toBe(false);
  });

  it("allows a restricted note to someone holding the named permission", () => {
    expect(canReadNote(restrictedToFinance, new Set(["MANAGE_FINANCE"]))).toBe(true);
  });

  it("a general export reader (VIEW_REPORTS only) never sees a restricted note's body", () => {
    // This is the acceptance criterion directly: a restricted note must not
    // appear in a general registration export.
    const exportReaderPermissions = new Set(["VIEW_REPORTS"]);
    const notes = [staffNote, restrictedToFinance];
    const visibleToExport = notes.filter((note) => canReadNote(note, exportReaderPermissions));
    expect(visibleToExport).toEqual([staffNote]);
    expect(visibleToExport).not.toContain(restrictedToFinance);
  });
});
