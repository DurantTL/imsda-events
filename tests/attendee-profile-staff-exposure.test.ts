import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The attendee's own mailing address and emergency contact (#742) reach staff
// only as answers on a registration. No staff people, profile, roster or export
// code may read these account columns.
const columns = /\b(mailingLine1|mailingLine2|mailingCity|mailingRegion|mailingPostalCode|mailingCountry|emergencyContactName|emergencyContactRelationship|emergencyContactPhone)\b/;
const allowed = new Set([
  "modules/attendee-accounts/profile-service.ts",
  "components/attendee-profile-form.tsx",
  // The WR26 import's own registration snapshot, not the attendee account.
  "modules/imports/repository.ts",
  "modules/imports/wr26-bundle.ts",
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name === ".next") return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("attendee profile address and emergency contact", () => {
  it("are read only by the attendee profile service and form", () => {
    const offenders = ["app", "modules", "components", "lib", "scripts"]
      .flatMap((directory) => sourceFiles(join(process.cwd(), directory)))
      .map((path) => path.slice(process.cwd().length + 1))
      .filter((path) => !allowed.has(path))
      .filter((path) => columns.test(readFileSync(join(process.cwd(), path), "utf8")));
    expect(offenders).toEqual([]);
  });
});
