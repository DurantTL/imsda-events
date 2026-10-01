import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { canonicalJson } from "@/modules/event-clones/domain";
import { parseEventTemplatePayload, validateEventTemplatePayloadReferences } from "@/modules/event-templates/domain";
import { pendingStarterEvents, starterDescription, starterEventTemplates, starterPayload } from "@/modules/event-templates/starters";

export type StarterTemplatesResult = {
  added: { starterKey: string; name: string; templateId: string }[];
  /** Unchanged starter drafts from an earlier run, published now (#617). */
  published: { starterKey: string; name: string; templateId: string }[];
  skipped: { starterKey: string; name: string; reason: "ALREADY_EXISTS" | "ARCHIVED"; templateId: string }[];
  stillNeeded: { starterKey: string; name: string; note: string }[];
};

/**
 * "Add starter templates" (#546): creates one PUBLISHED template per starter that
 * is not there yet. A starter is recognised by the `starterKey` in any of a
 * template's version payloads, so renaming, editing, publishing, or archiving
 * one never makes a re-run add a duplicate, and nothing existing is ever
 * modified or un-archived. One transaction under an advisory lock, so two
 * clicks at once cannot both add the same starter.
 */
export async function addStarterEventTemplates(actorUserId: string): Promise<StarterTemplatesResult> {
  const result: StarterTemplatesResult = {
    added: [],
    published: [],
    skipped: [],
    stillNeeded: pendingStarterEvents.map(({ starterKey, name, note }) => ({ starterKey, name, note })),
  };
  await getPrisma().$transaction(async (tx) => {
    // Bounded wait: past it the lock is SQLSTATE 55P03, reported as a retryable
    // 409 (TEMPLATE_BUSY) by `eventTemplateApiError`.
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('event-template-starters'))`;
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = 0");
    for (const starter of starterEventTemplates) {
      const existing = await tx.eventTemplate.findFirst({
        where: { versions: { some: { payload: { path: ["starterKey"], equals: starter.starterKey } } } },
        select: { id: true, name: true, description: true, status: true, versions: { select: { id: true, status: true, payload: true, versionNumber: true, updatedAt: true } } },
        orderBy: { createdAt: "asc" },
      });
      if (existing) {
        // A starter added as a draft before starters were published on creation (#617): publish it now,
        // but only when it was never published and it still equals the starter definition: name,
        // description and payload. A renamed, re-described or edited draft is somebody's work in
        // progress and is left alone.
        const [only] = existing.versions;
        // The row lock and a re-read of its status make a concurrent archive win: it can never be undone here.
        const lockedStatus = existing.status === "DRAFT"
          ? (await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS "status" FROM "EventTemplate" WHERE "id" = ${existing.id} FOR UPDATE`)[0]?.status
          : existing.status;
        if (lockedStatus === "DRAFT" && existing.versions.length === 1 && only!.status === "DRAFT"
          && existing.name === starter.name && existing.description === starterDescription(starter)
          && canonicalJson(only!.payload) === canonicalJson(starterPayload(starter))) {
          validateEventTemplatePayloadReferences(parseEventTemplatePayload(only!.payload));
          const { count } = await tx.eventTemplateVersion.updateMany({
            where: { id: only!.id, status: "DRAFT", updatedAt: only!.updatedAt },
            data: { status: "PUBLISHED", publishedAt: new Date() },
          });
          if (count === 1) {
            await tx.eventTemplate.updateMany({ where: { id: existing.id, status: "DRAFT" }, data: { status: "PUBLISHED" } });
            await tx.auditLog.create({ data: {
              actorUserId, action: "EVENT_TEMPLATE_PUBLISHED", entityType: "EventTemplate", entityId: existing.id,
              correlationId: randomUUID(), summary: `Published starter event template ${starter.name} version ${only!.versionNumber}.`,
              metadata: { versionId: only!.id, versionNumber: only!.versionNumber, starterKey: starter.starterKey },
            } });
            result.published.push({ starterKey: starter.starterKey, name: starter.name, templateId: existing.id });
            continue;
          }
        }
        result.skipped.push({
          starterKey: starter.starterKey,
          name: starter.name,
          reason: existing.status === "ARCHIVED" || lockedStatus === "ARCHIVED" ? "ARCHIVED" : "ALREADY_EXISTS",
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
          // Starters are conference-authored, so they are usable at once (#617); custom templates still publish by hand.
          status: "PUBLISHED",
          versions: { create: { createdByUserId: actorUserId, versionNumber: 1, status: "PUBLISHED", publishedAt: new Date(), payload: payload as unknown as Prisma.InputJsonValue } },
        },
      });
      await tx.auditLog.create({ data: {
        actorUserId, action: "EVENT_TEMPLATE_CREATED", entityType: "EventTemplate", entityId: template.id,
        correlationId: randomUUID(), summary: `Created starter event template ${template.name}.`,
        metadata: { audience: starter.audience, starterKey: starter.starterKey, published: true },
      } });
      result.added.push({ starterKey: starter.starterKey, name: starter.name, templateId: template.id });
    }
  });
  return result;
}

/**
 * First-visit seeding (#704): a database with no event templates at all gets the
 * starters on the first administrator visit to the templates page. Uses the same
 * idempotent, advisory-locked logic as "Add starter templates", so concurrent
 * visits cannot duplicate a starter, an existing starter in any state (edited,
 * renamed, archived) is never touched, and once any template exists this is a no-op.
 */
export async function ensureStarterEventTemplates(actorUserId: string): Promise<boolean> {
  if ((await getPrisma().eventTemplate.count()) > 0) return false;
  await addStarterEventTemplates(actorUserId);
  return true;
}
