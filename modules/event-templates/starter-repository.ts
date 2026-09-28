import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { validateEventTemplatePayloadReferences } from "@/modules/event-templates/domain";
import { pendingStarterEvents, starterDescription, starterEventTemplates, starterPayload } from "@/modules/event-templates/starters";

export type StarterTemplatesResult = {
  added: { starterKey: string; name: string; templateId: string }[];
  skipped: { starterKey: string; name: string; reason: "ALREADY_EXISTS" | "ARCHIVED"; templateId: string }[];
  stillNeeded: { starterKey: string; name: string; note: string }[];
};

/**
 * "Add starter templates" (#546): creates one DRAFT template per starter that
 * is not there yet. A starter is recognised by the `starterKey` in any of a
 * template's version payloads, so renaming, editing, publishing, or archiving
 * one never makes a re-run add a duplicate, and nothing existing is ever
 * modified or un-archived. One transaction under an advisory lock, so two
 * clicks at once cannot both add the same starter.
 */
export async function addStarterEventTemplates(actorUserId: string): Promise<StarterTemplatesResult> {
  const result: StarterTemplatesResult = {
    added: [],
    skipped: [],
    stillNeeded: pendingStarterEvents.map(({ starterKey, name, note }) => ({ starterKey, name, note })),
  };
  await getPrisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('event-template-starters'))`;
    for (const starter of starterEventTemplates) {
      const existing = await tx.eventTemplate.findFirst({
        where: { versions: { some: { payload: { path: ["starterKey"], equals: starter.starterKey } } } },
        select: { id: true, status: true },
        orderBy: { createdAt: "asc" },
      });
      if (existing) {
        result.skipped.push({
          starterKey: starter.starterKey,
          name: starter.name,
          reason: existing.status === "ARCHIVED" ? "ARCHIVED" : "ALREADY_EXISTS",
          templateId: existing.id,
        });
        continue;
      }
      const payload = starterPayload(starter);
      validateEventTemplatePayloadReferences(payload);
      const template = await tx.eventTemplate.create({
        data: {
          name: starter.name,
          description: starterDescription(starter),
          createdByUserId: actorUserId,
          versions: { create: { createdByUserId: actorUserId, versionNumber: 1, payload: payload as unknown as Prisma.InputJsonValue } },
        },
      });
      await tx.auditLog.create({ data: {
        actorUserId, action: "EVENT_TEMPLATE_CREATED", entityType: "EventTemplate", entityId: template.id,
        correlationId: randomUUID(), summary: `Created starter event template ${template.name}.`,
        metadata: { audience: starter.audience, starterKey: starter.starterKey },
      } });
      result.added.push({ starterKey: starter.starterKey, name: starter.name, templateId: template.id });
    }
  });
  return result;
}
