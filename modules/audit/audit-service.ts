import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { currentCorrelationId } from "@/lib/request-context";

export type AuditEntry = {
  eventId?: string;
  actorUserId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  /**
   * Omit it inside a request: the request's own ID is used, which is what ties
   * an audit entry to the log lines and the response header for the same call.
   * Callers that already mint one keep working unchanged.
   */
  correlationId?: string;
  summary: string;
  metadata?: Prisma.InputJsonValue;
};

type AuditClient = Prisma.TransactionClient | PrismaClient;

export async function writeAuditLog(
  entry: AuditEntry,
  client: AuditClient = getPrisma(),
) {
  return client.auditLog.create({
    data: {
      ...entry,
      correlationId: entry.correlationId ?? currentCorrelationId() ?? randomUUID(),
    },
  });
}

export async function listRecentAuditActivity(eventId: string, take = 12) {
  const rows = await getPrisma().auditLog.findMany({
    where: { eventId },
    orderBy: { createdAt: "desc" },
    take,
    include: { actor: { select: { displayName: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    summary: row.summary,
    actorName: row.actor?.displayName ?? "System",
    createdAt: row.createdAt.toISOString(),
  }));
}
