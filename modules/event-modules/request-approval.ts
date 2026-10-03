import "server-only";

import type { Prisma } from "@prisma/client";
import { writeAuditLog } from "@/modules/audit/audit-service";
import type { AuthenticatedUser } from "@/modules/access/authorization";
import { eventModuleDefinition, isEventModuleKey } from "@/modules/event-modules/catalog";
import { queueRequestDecidedEmail } from "@/modules/event-modules/request-email";

/**
 * A system administrator turned a module on directly (#741 slice 3): any
 * pending request for that event and module is answered by it. Each is marked
 * approved by the enabling admin, audited with ids and keys only, and the
 * requester gets the same approved email as an ordinary approval. Runs in the
 * enabling transaction. Returns the queued message ids, for delivery after commit.
 */
export async function approvePendingRequestsForEnabledModule(
  tx: Prisma.TransactionClient,
  actor: Pick<AuthenticatedUser, "id">,
  eventId: string,
  moduleKey: string,
): Promise<string[]> {
  const pending = await tx.moduleRequest.findMany({
    where: { eventId, moduleKey, status: "PENDING" },
    select: {
      id: true,
      event: { select: { name: true } },
      requestedBy: { select: { id: true, email: true, displayName: true } },
    },
  });
  const title = isEventModuleKey(moduleKey) ? eventModuleDefinition(moduleKey).title : moduleKey;
  const messageIds: string[] = [];
  for (const request of pending) {
    const claimed = await tx.moduleRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: { status: "APPROVED", decidedByUserId: actor.id, decidedAt: new Date(), declineReason: null },
    });
    if (claimed.count === 0) continue;
    await writeAuditLog({
      eventId,
      actorUserId: actor.id,
      action: "MODULE_REQUEST_APPROVED",
      entityType: "ModuleRequest",
      entityId: request.id,
      summary: `Approved the request for the ${title} module by turning it on.`,
      metadata: { eventId, moduleKey, requestId: request.id },
    }, tx);
    if (request.requestedBy) {
      messageIds.push(...await queueRequestDecidedEmail(tx, {
        requestId: request.id,
        decision: "APPROVED",
        moduleTitle: title,
        eventId,
        eventName: request.event.name,
        requester: request.requestedBy,
      }));
    }
  }
  return messageIds;
}
