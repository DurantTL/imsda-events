import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  AccessDeniedError,
  requirePermission,
  type AuthenticatedUser,
} from "@/modules/access/authorization";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  canEnableForEvent,
  dataForcedModuleKeys,
  eventModuleDefinition,
  isEventModuleKey,
  type EventModuleKey,
} from "@/modules/event-modules/catalog";
import {
  conferenceOfficeAddress,
  deliverRequestEmails,
  queueRequestDecidedEmail,
  queueRequestSubmittedEmail,
} from "@/modules/event-modules/request-email";
import {
  MODULE_REQUEST_DECLINE_REASON_MAX,
  MODULE_REQUEST_REASON_MAX,
  type ModuleRequestStatusValue,
} from "@/modules/event-modules/request-domain";
import { dataPresentByEvent, enableModuleInTransaction, EventModuleError } from "@/modules/event-modules/service";
import { findActiveMembership } from "@/modules/events/repository";

/**
 * Module requests (#741 slice 3): an event admin asks, a system administrator
 * decides. Rules are in `request-domain.ts`. Audit entries carry ids and the
 * module key only; the free-text reasons never go into audit metadata.
 */

export class ModuleRequestError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_REASON" | "ALREADY_ENABLED" | "ALREADY_PENDING" | "REQUEST_NOT_FOUND" | "ALREADY_DECIDED" | "SYSTEM_ADMIN_ENABLES_DIRECTLY",
  ) {
    super(message);
    this.name = "ModuleRequestError";
  }
}

type Actor = Pick<AuthenticatedUser, "id" | "globalRole">;

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function cleanReason(value: string, max: number, what: string) {
  const reason = value.trim();
  if (!reason) throw new ModuleRequestError(`${what} is required.`, "INVALID_REASON");
  if (reason.length > max) throw new ModuleRequestError(`${what} must be ${max} characters or fewer.`, "INVALID_REASON");
  return reason;
}

/**
 * Asks for a module to be turned on. The requester must be an active Event
 * Admin of the event (`CONFIGURE_EVENT`). Refused when the module is already on
 * for the event, does not apply to it, or already has a pending request.
 */
export async function createModuleRequest(
  actor: AuthenticatedUser | null | undefined,
  eventId: string,
  moduleKey: string,
  reasonInput: string,
): Promise<{ id: string }> {
  if (actor?.globalRole === "SYSTEM_ADMIN") {
    throw new ModuleRequestError("System administrators turn modules on directly; they do not request them.", "SYSTEM_ADMIN_ENABLES_DIRECTLY");
  }
  const { user } = await requirePermission({ user: actor ?? null }, eventId, "CONFIGURE_EVENT", findActiveMembership);
  if (!isEventModuleKey(moduleKey)) throw new EventModuleError("That module does not exist.", "UNKNOWN_MODULE");
  const key: EventModuleKey = moduleKey;
  const reason = cleanReason(reasonInput, MODULE_REQUEST_REASON_MAX, "A reason");
  const officeEmail = await conferenceOfficeAddress();
  const prisma = getPrisma();
  try {
    const { id, messageIds } = await prisma.$transaction(async (tx) => {
      const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true, name: true, audience: true } });
      if (!event) throw new EventModuleError("That event does not exist.", "EVENT_NOT_FOUND");
      const definition = eventModuleDefinition(key);
      const dataKeys = dataForcedModuleKeys.includes(key) ? [key] : [];
      const present = (await dataPresentByEvent(tx, [eventId], key === "honors" ? ["honors"] : dataKeys)).get(eventId);
      if (!canEnableForEvent(key, event.audience, present)) {
        throw new EventModuleError(`${definition.title} applies to club events only.`, "NOT_APPLICABLE");
      }
      const row = definition.alwaysOn
        ? { id: "always-on" }
        : await tx.eventModule.findUnique({ where: { eventId_moduleKey: { eventId, moduleKey: key } }, select: { id: true } });
      if (row || (dataForcedModuleKeys.includes(key) && present?.has(key))) {
        throw new ModuleRequestError(`${definition.title} is already on for this event.`, "ALREADY_ENABLED");
      }
      const pending = await tx.moduleRequest.findFirst({ where: { eventId, moduleKey: key, status: "PENDING" }, select: { id: true } });
      if (pending) throw new ModuleRequestError(`${definition.title} already has a request waiting for a decision.`, "ALREADY_PENDING");
      const created = await tx.moduleRequest.create({
        data: { eventId, moduleKey: key, requestedByUserId: user.id, reason },
        select: { id: true },
      });
      await writeAuditLog({
        eventId,
        actorUserId: user.id,
        action: "MODULE_REQUEST_CREATED",
        entityType: "ModuleRequest",
        entityId: created.id,
        summary: `Asked for the ${definition.title} module.`,
        metadata: { eventId, moduleKey: key, requestId: created.id },
      }, tx);
      const queued = await queueRequestSubmittedEmail(tx, officeEmail, {
        requestId: created.id,
        moduleTitle: definition.title,
        eventName: event.name,
        requesterName: user.displayName || user.email,
        reason,
      });
      return { id: created.id, messageIds: queued };
    });
    await deliverRequestEmails(messageIds);
    return { id };
  } catch (error) {
    // The partial unique index decided a concurrent double submit.
    if (isUniqueViolation(error)) {
      throw new ModuleRequestError(`${eventModuleDefinition(key).title} already has a request waiting for a decision.`, "ALREADY_PENDING");
    }
    throw error;
  }
}

function requireSystemAdmin(actor: Pick<AuthenticatedUser, "id" | "globalRole"> | null | undefined): asserts actor is Actor {
  if (!actor) throw new AccessDeniedError("Authentication is required.", 401, "AUTHENTICATION_REQUIRED");
  if (actor.globalRole !== "SYSTEM_ADMIN") {
    throw new AccessDeniedError("Only a system administrator can approve or decline a feature request.", 403, "PERMISSION_DENIED");
  }
}

export type ModuleRequestDecision = { decision: "approve" } | { decision: "decline"; declineReason: string };

/**
 * Approves or declines a pending request. System administrators only. Approving
 * turns the module on through the existing enable step, in the same transaction,
 * so a module the event cannot use leaves the request pending. Declining needs a reason.
 */
export async function decideModuleRequest(
  actor: Pick<AuthenticatedUser, "id" | "globalRole"> | null | undefined,
  requestId: string,
  input: ModuleRequestDecision,
): Promise<{ status: ModuleRequestStatusValue }> {
  requireSystemAdmin(actor);
  const declineReason = input.decision === "decline"
    ? cleanReason(input.declineReason, MODULE_REQUEST_DECLINE_REASON_MAX, "A reason for declining")
    : undefined;
  const status: ModuleRequestStatusValue = input.decision === "approve" ? "APPROVED" : "DECLINED";
  const messageIds = await getPrisma().$transaction(async (tx) => {
    // The conditional update is the claim: of two deciders, one wins.
    const claimed = await tx.moduleRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: { status, decidedByUserId: actor.id, decidedAt: new Date(), declineReason: declineReason ?? null },
    });
    const request = await tx.moduleRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        eventId: true,
        moduleKey: true,
        event: { select: { name: true } },
        requestedBy: { select: { id: true, email: true, displayName: true } },
      },
    });
    if (!request) throw new ModuleRequestError("That request does not exist.", "REQUEST_NOT_FOUND");
    if (claimed.count === 0) throw new ModuleRequestError("That request was already decided.", "ALREADY_DECIDED");
    const definition = isEventModuleKey(request.moduleKey) ? eventModuleDefinition(request.moduleKey) : null;
    const title = definition?.title ?? request.moduleKey;
    if (input.decision === "approve") await enableModuleInTransaction(tx, actor, request.eventId, request.moduleKey);
    await writeAuditLog({
      eventId: request.eventId,
      actorUserId: actor.id,
      action: input.decision === "approve" ? "MODULE_REQUEST_APPROVED" : "MODULE_REQUEST_DECLINED",
      entityType: "ModuleRequest",
      entityId: request.id,
      summary: `${input.decision === "approve" ? "Approved" : "Declined"} the request for the ${title} module.`,
      metadata: { eventId: request.eventId, moduleKey: request.moduleKey, requestId: request.id },
    }, tx);
    return request.requestedBy
      ? queueRequestDecidedEmail(tx, {
          requestId: request.id,
          decision: status as "APPROVED" | "DECLINED",
          moduleTitle: title,
          eventId: request.eventId,
          eventName: request.event.name,
          requester: request.requestedBy,
          declineReason,
        })
      : [];
  });
  await deliverRequestEmails(messageIds);
  return { status };
}

export type PendingModuleRequest = {
  id: string;
  eventId: string;
  eventName: string;
  moduleKey: string;
  moduleTitle: string;
  requesterName: string;
  reason: string;
  createdAt: Date;
};

/** The System management queue: every pending request, oldest first. */
export async function listPendingModuleRequests(): Promise<PendingModuleRequest[]> {
  const rows = await getPrisma().moduleRequest.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: {
      id: true,
      eventId: true,
      moduleKey: true,
      reason: true,
      createdAt: true,
      event: { select: { name: true } },
      requestedBy: { select: { displayName: true, email: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    eventId: row.eventId,
    eventName: row.event.name,
    moduleKey: row.moduleKey,
    moduleTitle: isEventModuleKey(row.moduleKey) ? eventModuleDefinition(row.moduleKey).title : row.moduleKey,
    requesterName: row.requestedBy?.displayName || row.requestedBy?.email || "Former staff member",
    reason: row.reason,
    createdAt: row.createdAt,
  }));
}

export type EventModuleRequestStatus = {
  moduleKey: string;
  status: ModuleRequestStatusValue;
  createdAt: Date;
  decidedAt: Date | null;
  declineReason: string | null;
};

/** An event's requests, newest first, for the requester's /more status. */
export async function listModuleRequestsForEvent(eventId: string): Promise<EventModuleRequestStatus[]> {
  return getPrisma().moduleRequest.findMany({
    where: { eventId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { moduleKey: true, status: true, createdAt: true, decidedAt: true, declineReason: true },
  });
}
