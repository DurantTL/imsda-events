import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural guards for club forms' privacy promises (#610): sensitive answers
 * must never reach public-form drafts, the check-in book, logs or CSVs. They
 * are kept out by construction (club forms have their own tables and modules),
 * and these tests fail if someone wires them together.
 */

const root = process.cwd();

function sourceFiles(directory: string): string[] {
  return readdirSync(join(root, directory)).flatMap((name) => {
    const relative = join(directory, name);
    if (statSync(join(root, relative)).isDirectory()) return sourceFiles(relative);
    return /\.(ts|tsx)$/.test(name) ? [relative] : [];
  });
}

const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("club forms stay apart from the places sensitive answers must never go (#610)", () => {
  it("is not imported by the check-in book or the public form draft path", () => {
    const guarded = [
      ...sourceFiles("modules/checkin"),
      ...sourceFiles("modules/public-access"),
      ...sourceFiles("modules/registrations"),
      "modules/forms/public-draft.ts",
      "modules/forms/public-repository.ts",
      "modules/forms/public-domain.ts",
      "modules/forms/sensitive-fields.ts",
    ];
    for (const file of guarded) expect(read(file), file).not.toMatch(/club-forms|ClubFormSubmission|sealedSensitiveAnswers/);
  });

  it("never reads the sealed column outside the one audited read", () => {
    const readers = [...sourceFiles("modules"), ...sourceFiles("app"), ...sourceFiles("components")]
      .filter((file) => read(file).includes("sealedSensitiveAnswers"))
      .sort();
    // The write paths (which only set it), the one audited read, the re-seal step a template version bump runs,
    // and the coordinator health view (#658, ADR 0005 Addendum C), which audits before it opens two emergency fields.
    expect(readers).toEqual([
      "modules/club-forms/links.ts",
      "modules/club-forms/reseal.ts",
      "modules/club-forms/submissions.ts",
      "modules/coordinator-health/repository.ts",
    ]);
  });

  it("opens sealed answers only in the audited read and the re-seal step", () => {
    const openers = [...sourceFiles("modules"), ...sourceFiles("app"), ...sourceFiles("components")]
      .filter((file) => /openSensitiveAnswers\(/.test(read(file)) && !file.endsWith("sealed-answers.ts"))
      .sort();
    expect(openers).toEqual(["modules/club-forms/reseal.ts", "modules/club-forms/submissions.ts", "modules/coordinator-health/repository.ts"]);
  });

  it("never logs a request body, an answers object or a token", () => {
    const files = [
      ...sourceFiles("modules/club-forms"),
      ...sourceFiles("app/api/attendee/clubs/[organizationId]/forms"),
      ...sourceFiles("app/api/public/club-forms"),
      ...sourceFiles("app/api/staff/club-forms"),
      ...sourceFiles("app/api/admin/club-forms"),
    ];
    for (const file of files) {
      const calls = read(file).match(/log(?:Error|Info|Warn)\([^;]*;/g) ?? [];
      for (const call of calls) expect(call, `${file}: ${call}`).not.toMatch(/answers|body|token|sensitive|request\b(?!\.)/i);
    }
  });

  it("keeps the CSV builder from selecting the sealed column", () => {
    expect(read("modules/club-forms/csv.ts")).not.toMatch(/sealedSensitiveAnswers|openSensitiveAnswers/);
  });

  it("keeps list queries from selecting answers", () => {
    const source = read("modules/club-forms/submissions.ts");
    const list = source.slice(source.indexOf("export async function listSubmissionsForViewer"), source.indexOf("export type ClubFormSubmissionListRow"));
    expect(list).not.toMatch(/answers:\s*true|sealedSensitiveAnswers/);
  });
});
