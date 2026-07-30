import "server-only";

import { getPrisma } from "@/lib/prisma";
import { activeRegistrationStatuses } from "@/modules/events/lifecycle";
import { listRegistrations } from "@/modules/registrations/repository";
import { buildOperationalReport } from "@/modules/reporting/operational-reports";
import {
  buildRetreatPacketGroups,
  type RetreatPacketAssignment,
} from "@/modules/reporting/retreat-packets";

export async function getRetreatPackets(eventId: string) {
  const [event, registrations, runs] = await Promise.all([
    getPrisma().event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        slug: true,
        name: true,
        startsAt: true,
        endsAt: true,
        timezone: true,
        location: true,
        supportContact: true,
        contentSections: {
          where: { isPublished: true },
          orderBy: { position: "asc" },
          select: {
            id: true,
            kind: true,
            title: true,
            body: true,
            links: {
              orderBy: { position: "asc" },
              select: { label: true, description: true, url: true, assetId: true },
            },
          },
        },
      },
    }),
    listRegistrations(eventId, { statuses: activeRegistrationStatuses }),
    getPrisma().programAssignmentRun.findMany({
      where: { eventId },
      orderBy: [{ appliedAt: "desc" }, { id: "desc" }],
      select: {
        fieldId: true,
        fieldLabelSnapshot: true,
        assignments: {
          orderBy: { stableOrder: "asc" },
          select: { attendeeIdSnapshot: true, optionValue: true },
        },
      },
    }),
  ]);
  if (!event) return null;

  const latestFields = new Set<string>();
  const assignments: RetreatPacketAssignment[] = [];
  for (const run of runs) {
    if (latestFields.has(run.fieldId)) continue;
    latestFields.add(run.fieldId);
    assignments.push(...run.assignments.map((assignment) => ({
      fieldLabel: run.fieldLabelSnapshot,
      attendeeId: assignment.attendeeIdSnapshot,
      option: assignment.optionValue,
    })));
  }
  const report = buildOperationalReport(registrations);
  return {
    event: {
      ...event,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
    },
    summary: report.summary,
    groups: buildRetreatPacketGroups(registrations, report.rosterGroups, assignments),
  };
}
