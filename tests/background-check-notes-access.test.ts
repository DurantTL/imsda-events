import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canSeeIssuesText } from "@/modules/background-checks/notes-access";

describe("who sees the background-check issues text on screen (#427, #544)", () => {
  it("is system administrators only", () => {
    expect(canSeeIssuesText({ globalRole: "SYSTEM_ADMIN" })).toBe(true);
  });

  it("is nobody else: event workspace roles, finance, registration, no role, or signed out", () => {
    for (const globalRole of ["EVENT_ADMIN", "FINANCE", "REGISTRATION_MANAGER", "REPORTER", "", null, undefined]) {
      expect(canSeeIssuesText({ globalRole })).toBe(false);
    }
    expect(canSeeIssuesText(null)).toBe(false);
    expect(canSeeIssuesText(undefined)).toBe(false);
  });

  it("is what the event pages that list background-check flags pass as includeNotes", () => {
    for (const page of ["app/(workspace)/more/reports/page.tsx", "app/(workspace)/more/clubs/[organizationId]/page.tsx"]) {
      const source = readFileSync(path.join(process.cwd(), page), "utf8");
      expect(source).toContain("includeNotes: canSeeIssuesText(user)");
    }
  });
});
