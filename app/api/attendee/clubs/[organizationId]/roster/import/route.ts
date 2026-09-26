import { z } from "zod";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { rejectCrossOriginRequest } from "@/modules/access/request-security";
import { actorAttribution, requireRosterAccess } from "@/modules/club-rosters/access";
import { rosterApiError } from "@/modules/club-rosters/api-errors";
import { MAX_ROSTER_CSV_BYTES, parseRosterCsv, planRosterImport, rosterCsvAddDefaults, RosterCsvError } from "@/modules/club-rosters/csv-import";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { addRosterMember, listRoster, RosterOperationError, updateRosterMember } from "@/modules/club-rosters/repository";
import { withRequestContext } from "@/lib/request-context";

const importSchema = z.object({
  csv: z.string().max(MAX_ROSTER_CSV_BYTES, "That file is too large. Upload up to 500 people at a time."),
  confirm: z.boolean().default(false),
}).strict();

function publicStep(step: ReturnType<typeof planRosterImport>[number]) {
  return { line: step.line, name: step.name, action: step.action, message: step.message };
}

/**
 * Roster CSV upload (#384). Without `confirm` it only previews; with it, each
 * row is added or updated through the normal roster functions, so a bad row
 * is skipped on its own and never half-saved. Audited with counts only.
 */
async function postHandler(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const originError = rejectCrossOriginRequest(request);
  if (originError) return originError;
  try {
    const { organizationId } = await context.params;
    const access = await requireRosterAccess(organizationId);
    const { csv, confirm } = importSchema.parse(await request.json());
    let rows;
    try {
      rows = parseRosterCsv(csv);
    } catch (error) {
      if (error instanceof RosterCsvError) return Response.json({ error: "INVALID_ROSTER_CSV", message: error.message }, { status: 400 });
      throw error;
    }
    const clubYear = clubYearFor(new Date());
    const existing = (await listRoster(organizationId, clubYear)).map((member) => ({ id: member.id, firstName: member.firstName, lastName: member.lastName }));
    const plan = planRosterImport(rows, existing);
    if (!confirm) return Response.json({ steps: plan.map(publicStep) }, { headers: { "Cache-Control": "no-store" } });

    const actor = actorAttribution(access.actor);
    const results = [];
    let added = 0;
    let updated = 0;
    for (const step of plan) {
      const { row } = step;
      try {
        if (step.action === "ADD") {
          /** Blank type → Youth; blank role defaults by type (#424), same as the roster form and the preview. */
          const { attendeeType, role } = rosterCsvAddDefaults(row);
          await addRosterMember(organizationId, clubYear, {
            firstName: row.firstName,
            lastName: row.lastName,
            birthDate: row.birthDate!,
            attendeeType,
            role,
            classLevel: row.classLevel ?? null,
            gender: row.gender ?? null,
          }, actor);
          added += 1;
          results.push({ ...publicStep(step), message: "Added." });
        } else if (step.action === "UPDATE" && step.memberId) {
          await updateRosterMember(organizationId, step.memberId, {
            ...(row.birthDate === undefined ? {} : { birthDate: row.birthDate }),
            ...(row.attendeeType === undefined ? {} : { attendeeType: row.attendeeType }),
            ...(row.classLevel === undefined ? {} : { classLevel: row.classLevel }),
            ...(row.role === undefined ? {} : { role: row.role }),
            ...(row.gender === undefined ? {} : { gender: row.gender }),
          }, actor);
          updated += 1;
          results.push({ ...publicStep(step), message: "Updated." });
        } else {
          results.push(publicStep(step));
        }
      } catch (error) {
        if (!(error instanceof RosterOperationError)) throw error;
        results.push({ ...publicStep(step), action: "SKIP" as const, message: error.message });
      }
    }
    await writeAuditLog({
      ...("userId" in actor ? { actorUserId: actor.userId } : {}),
      action: "CLUB_ROSTER_CSV_IMPORTED",
      entityType: "Organization",
      entityId: organizationId,
      summary: "Imported a roster CSV.",
      metadata: {
        organizationId,
        clubYear,
        rows: plan.length,
        added,
        updated,
        skipped: plan.length - added - updated,
        ...("accountId" in actor ? { actorAttendeeAccountId: actor.accountId } : { actAsId: actor.actAsId }),
      },
    });
    return Response.json({ steps: results, added, updated, members: await listRoster(organizationId, clubYear) });
  } catch (error) {
    return rosterApiError(error, "Importing the roster");
  }
}

export const POST = withRequestContext(postHandler);
