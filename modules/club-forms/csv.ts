import "server-only";

import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { formatClubFormAnswer, type ClubFormsViewer } from "@/modules/club-forms/domain";
import { ClubFormError } from "@/modules/club-forms/errors";
import { getClubFormTemplateForStaff } from "@/modules/club-forms/templates";
import { exportColumnsAcrossVersions, listClubFormTemplateVersions } from "@/modules/club-forms/versions";
import { toCsv } from "@/modules/reporting/csv";

/**
 * The staff CSV of submitted forms for one template (#610): who and when, plus
 * the template's non-sensitive answers. Sensitive columns are not merely
 * blank; they are absent, and the sealed column is never read, so a sensitive
 * answer cannot reach the file. Cells go through the formula-safe escaper.
 */

export async function buildClubFormsCsv(
  viewer: ClubFormsViewer,
  input: { templateKey: string; organizationId?: string },
) {
  if (viewer.kind !== "STAFF") throw new ClubFormError("FORBIDDEN", "Only conference staff can export forms.");
  const prisma = getPrisma();
  const template = await getClubFormTemplateForStaff(input.templateKey, prisma);
  // Columns cover every version (#712): a field a later version dropped or hid still has answers in older submissions.
  // A key that was sensitive in any version stays out of the file.
  const versions = await listClubFormTemplateVersions(template, prisma);
  const sensitive = new Set(versions.flatMap((version) => version.sensitiveFieldKeys));
  const columns = exportColumnsAcrossVersions(versions, sensitive);

  const rows = await prisma.clubFormSubmission.findMany({
    where: {
      templateId: template.id,
      status: "SUBMITTED",
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    },
    orderBy: [{ organization: { name: "asc" } }, { submittedAt: "asc" }],
    select: {
      clubYear: true,
      subjectName: true,
      templateVersion: true,
      status: true,
      submittedAt: true,
      enteredVia: true,
      answers: true,
      organization: { select: { name: true } },
    },
  });

  const header = ["Form", "Club", "Club year", "Member or subject", "Status", "Submitted at", "Entered by", ...columns.map((column) => column.heading)];
  const body = rows.map((row) => {
    const answers = row.answers as Record<string, unknown>;
    return [
      template.name,
      row.organization.name,
      row.clubYear,
      row.subjectName,
      row.status,
      row.submittedAt?.toISOString() ?? "",
      row.enteredVia === "LINK" ? "Private link" : "Club director",
      ...columns.map((column) => formatClubFormAnswer(column.byVersion.get(row.templateVersion) ?? column.latest, answers[column.key])),
    ];
  });

  await writeAuditLog({
    actorUserId: viewer.userId,
    action: "CLUB_FORMS_EXPORTED",
    entityType: "ClubFormTemplate",
    entityId: template.id,
    summary: "Exported submitted club forms (non-sensitive columns).",
    metadata: { templateKey: template.key, rowCount: rows.length, organizationId: input.organizationId ?? null },
  });
  return { filename: `${template.key}.csv`, csv: toCsv([header, ...body]), rowCount: rows.length };
}
