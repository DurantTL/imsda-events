import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractMessageTemplateTokens } from "@/modules/communications/templates";

/**
 * `{{contact_email}}` changed meaning, and the migration rewrites every stored
 * template version to `{{registration_contact_email}}` so an already-published
 * template keeps rendering the value it rendered before.
 *
 * The risk is a spelling the migration misses. The renderer trims arbitrary
 * whitespace inside the braces, so several spellings are equally valid and
 * staff may have saved any of them; one the migration does not match would
 * survive the deploy and silently start meaning something else.
 *
 * These tests read the shipped SQL and exercise its actual pattern, rather than
 * a copy that could drift from it. PostgreSQL and JavaScript agree on this
 * subset of regular-expression syntax — character classes, `\s`, quantifiers —
 * so the pattern can be applied here directly.
 */
const MIGRATION_SQL = readFileSync(
  "prisma/migrations/20260801090000_event_lodging_and_contact_tokens/migration.sql",
  "utf8",
);

/** Every spelling the template parser accepts as `contact_email`. */
const HISTORICAL_SPELLINGS = [
  "{{contact_email}}",
  "{{ contact_email }}",
  "{{contact_email }}",
  "{{ contact_email}}",
  "{{  contact_email  }}",
  "{{\tcontact_email\t}}",
];

function migrationPattern() {
  const match = /regexp_replace\(\s*"\w+",\s*'([^']+)'/.exec(MIGRATION_SQL);
  if (!match) throw new Error("The migration no longer uses a regexp_replace pattern.");
  return new RegExp(match[1], "g");
}

describe("contact_email token migration", () => {
  it("uses a regular expression rather than literal string replacement", () => {
    expect(MIGRATION_SQL).toContain("regexp_replace(");
    // A pair of REPLACE calls would migrate two spellings and quietly change
    // the meaning of every other valid one.
    expect(MIGRATION_SQL).not.toContain("REPLACE(\"bodyTemplate\"");
  });

  it("rewrites every spelling the template parser accepts", () => {
    for (const spelling of HISTORICAL_SPELLINGS) {
      // The parser really does read all of these as the same token.
      expect(extractMessageTemplateTokens(spelling)).toEqual(["contact_email"]);

      const migrated = `Questions? Contact ${spelling}.`.replace(
        migrationPattern(),
        "{{registration_contact_email}}",
      );
      expect(migrated).toBe("Questions? Contact {{registration_contact_email}}.");
      expect(extractMessageTemplateTokens(migrated)).toEqual([
        "registration_contact_email",
      ]);
    }
  });

  it("rewrites every occurrence in one body, not only the first", () => {
    const migrated = "{{contact_email}} and {{ contact_email }} and {{contact_email}}"
      .replace(migrationPattern(), "{{registration_contact_email}}");

    expect(migrated).toBe(
      "{{registration_contact_email}} and {{registration_contact_email}} and {{registration_contact_email}}",
    );
  });

  it("leaves other tokens alone, including the one it writes", () => {
    const untouched = [
      "{{registration_contact_email}}",
      "{{reply_to_email}}",
      "{{event_name}}",
      "{{contact_email_extra}}",
    ].join(" ");

    expect(untouched.replace(migrationPattern(), "{{registration_contact_email}}"))
      .toBe(untouched);
  });

  it("guards both the subject and the body", () => {
    expect(MIGRATION_SQL).toContain('SET "bodyTemplate" = regexp_replace(');
    expect(MIGRATION_SQL).toContain('SET "subjectTemplate" = regexp_replace(');
  });
});
