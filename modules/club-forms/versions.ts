import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  allFields,
  sectionNotesSchema,
  type ClubFormTemplateRecord,
} from "@/modules/club-forms/domain";
import type { ClubFormProtectionHistory } from "@/modules/club-forms/builder-domain";
import { registrationFormDefinitionSchema, type RegistrationFormField } from "@/modules/forms/definition";

/**
 * Published versions of a club form template (#712). Each publish (and each
 * sync of a code seed) records a frozen copy, so a submission is always
 * shown and exported against the version it was filled in against. Rows are
 * only ever added.
 */

type Client = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

type VersionSpec = {
  version: number;
  name: string;
  description: string;
  definition: unknown;
  sectionNotes: unknown;
  sensitiveFieldKeys: string[];
  birthDateFieldKeys: string[];
  staffOnlyFieldKeys: string[];
  hiddenFieldKeys: string[];
  printLayout: string;
};

/** Records one version of a template. Recording the same version again changes nothing. */
export async function recordClubFormTemplateVersion(
  client: Client,
  templateId: string,
  spec: VersionSpec,
  createdByUserId: string | null = null,
) {
  await client.clubFormTemplateVersion.createMany({
    data: [{
      templateId,
      version: spec.version,
      name: spec.name,
      description: spec.description,
      definition: spec.definition as Prisma.InputJsonValue,
      sectionNotes: spec.sectionNotes as Prisma.InputJsonValue,
      sensitiveFieldKeys: spec.sensitiveFieldKeys,
      birthDateFieldKeys: spec.birthDateFieldKeys,
      staffOnlyFieldKeys: spec.staffOnlyFieldKeys,
      hiddenFieldKeys: spec.hiddenFieldKeys,
      printLayout: spec.printLayout,
      createdByUserId,
    }],
    skipDuplicates: true,
  });
}

const versionSelect = {
  version: true,
  definition: true,
  sectionNotes: true,
  sensitiveFieldKeys: true,
  birthDateFieldKeys: true,
  staffOnlyFieldKeys: true,
  hiddenFieldKeys: true,
  printLayout: true,
} satisfies Prisma.ClubFormTemplateVersionSelect;

type VersionRow = Prisma.ClubFormTemplateVersionGetPayload<{ select: typeof versionSelect }>;

function union(...lists: ReadonlyArray<readonly string[]>) {
  return [...new Set(lists.flat())];
}

/**
 * The template as it was at `version`: that version's definition, notes,
 * staff-only fields and print layout. The sensitive and birth-date keys are
 * the union with the current ones, so a field can only ever be treated as
 * more restricted, never less (flags cannot be removed once published, and a
 * key made sensitive later was re-sealed in every older submission).
 */
function recordAtVersion(current: ClubFormTemplateRecord, row: VersionRow): ClubFormTemplateRecord {
  return {
    ...current,
    version: row.version,
    definition: registrationFormDefinitionSchema.parse(row.definition),
    sectionNotes: sectionNotesSchema.parse(row.sectionNotes ?? {}),
    sensitiveFieldKeys: union(row.sensitiveFieldKeys, current.sensitiveFieldKeys),
    birthDateFieldKeys: union(row.birthDateFieldKeys, current.birthDateFieldKeys),
    staffOnlyFieldKeys: row.staffOnlyFieldKeys,
    hiddenFieldKeys: row.hiddenFieldKeys,
    printLayout: row.printLayout === "PASSENGER_LIST" ? "PASSENGER_LIST" : "STANDARD",
  };
}

/**
 * The version a submission was filled in against. When that version was never
 * recorded (a submission from before versions were kept), the current one.
 */
export async function getClubFormTemplateAtVersion(
  current: ClubFormTemplateRecord,
  version: number,
  client: Client = getPrisma(),
): Promise<ClubFormTemplateRecord> {
  if (version === current.version) return current;
  const row = await client.clubFormTemplateVersion.findUnique({
    where: { templateId_version: { templateId: current.id, version } },
    select: versionSelect,
  });
  return row ? recordAtVersion(current, row) : current;
}

/** Every recorded version of a template, oldest first, as records. The current one is included. */
export async function listClubFormTemplateVersions(current: ClubFormTemplateRecord, client: Client = getPrisma()) {
  const rows = await client.clubFormTemplateVersion.findMany({
    where: { templateId: current.id },
    orderBy: { version: "asc" },
    select: versionSelect,
  });
  const records = rows.filter((row) => row.version !== current.version).map((row) => recordAtVersion(current, row));
  return [...records, current].sort((left, right) => left.version - right.version);
}

export type ExportColumn = {
  key: string;
  heading: string;
  /** The field as the newest version that had it defines it. */
  latest: RegistrationFormField;
  /** The field as each version defines it, so a row is formatted by its own version. */
  byVersion: Map<number, RegistrationFormField>;
};

/**
 * The columns a staff export needs: every non-sensitive field any version had,
 * oldest first. A key keeps one column; headings are unique, so two columns
 * that carry the same label (a key that was renamed) get the key appended.
 */
export function exportColumnsAcrossVersions(versions: readonly ClubFormTemplateRecord[], sensitiveKeys: ReadonlySet<string>): ExportColumn[] {
  const columns = new Map<string, ExportColumn>();
  for (const record of versions) {
    for (const field of allFields(record.definition)) {
      if (sensitiveKeys.has(field.key)) continue;
      const column = columns.get(field.key) ?? { key: field.key, heading: field.label, latest: field, byVersion: new Map() };
      column.latest = field;
      column.heading = field.label;
      column.byVersion.set(record.version, field);
      columns.set(field.key, column);
    }
  }
  const list = [...columns.values()];
  const counts = new Map<string, number>();
  for (const column of list) counts.set(column.heading, (counts.get(column.heading) ?? 0) + 1);
  const used = new Set<string>();
  for (const column of list) {
    let heading = (counts.get(column.heading) ?? 0) > 1 ? `${column.heading} (${column.key})` : column.heading;
    while (used.has(heading)) heading = `${heading} (${column.key})`;
    used.add(heading);
    column.heading = heading;
  }
  return list;
}

/** What earlier versions fix in place, read inside the publishing transaction. */
export async function loadProtectionHistory(
  client: Client,
  template: { id: string; sensitiveFieldKeys: readonly string[]; birthDateFieldKeys: readonly string[]; definition: unknown },
): Promise<ClubFormProtectionHistory> {
  const [rows, submissionCount] = await Promise.all([
    client.clubFormTemplateVersion.findMany({
      where: { templateId: template.id },
      select: { sensitiveFieldKeys: true, birthDateFieldKeys: true },
    }),
    client.clubFormSubmission.count({ where: { templateId: template.id } }),
  ]);
  const published = registrationFormDefinitionSchema.parse(template.definition);
  return {
    everSensitiveKeys: union(template.sensitiveFieldKeys, ...rows.map((row) => row.sensitiveFieldKeys)),
    everBirthDateKeys: union(template.birthDateFieldKeys, ...rows.map((row) => row.birthDateFieldKeys)),
    hasSubmissions: submissionCount > 0,
    publishedFieldKeys: allFields(published).map((field) => field.key),
  };
}

