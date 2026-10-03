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

// Synthetic-data verify scripts that create an account and use only its id.
const createdAndUsedForIdOnly = new Set(["scripts/verify-event-deletion.ts", "scripts/verify-honor-entry-void.ts"]);

function allSources() {
  return ["app", "modules", "components", "lib", "scripts"]
    .flatMap((directory) => sourceFiles(join(process.cwd(), directory)))
    .map((path) => path.slice(process.cwd().length + 1));
}

/** The text of the balanced call starting at the "(" at `open`. */
function callText(source: string, open: number) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")" && --depth === 0) return source.slice(open, index + 1);
  }
  return source.slice(open);
}

describe("attendee profile address and emergency contact", () => {
  it("are never loaded by an AttendeeAccount query that has no select", () => {
    const offenders = allSources().filter((path) => !createdAndUsedForIdOnly.has(path)).filter((path) => {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      return [...source.matchAll(/\battendeeAccount\.(findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|update|upsert|create)\(/g)]
        .some((match) => {
          const call = callText(source, match.index! + match[0].length - 1);
          if (/\bselect\s*:/.test(call)) return false;
          // A write whose result is discarded never reads the columns back.
          if (/^(update|upsert|create)$/.test(match[1]!)) {
            const linePrefix = source.slice(source.lastIndexOf("\n", match.index!) + 1, match.index!);
            if (!/(=|\breturn\b|=>)/.test(linePrefix)) return false;
          }
          return true;
        });
    });
    expect(offenders).toEqual([]);
  });

  it("are never pulled in by including an AttendeeAccount relation", () => {
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const relations = [...schema.matchAll(/^\s+(\w+)\s+AttendeeAccount\??\s+@relation/gm)].map((match) => match[1]!);
    expect(relations.length).toBeGreaterThan(0);
    const includeRelation = new RegExp(`include\\s*:\\s*\\{[^}]*\\b(${relations.join("|")})\\s*:\\s*true`);
    const offenders = allSources().filter((path) => includeRelation.test(readFileSync(join(process.cwd(), path), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("are read only by the attendee profile service and form", () => {
    const offenders = ["app", "modules", "components", "lib", "scripts"]
      .flatMap((directory) => sourceFiles(join(process.cwd(), directory)))
      .map((path) => path.slice(process.cwd().length + 1))
      .filter((path) => !allowed.has(path))
      .filter((path) => columns.test(readFileSync(join(process.cwd(), path), "utf8")));
    expect(offenders).toEqual([]);
  });
});
