import "server-only";

import { getPrisma } from "@/lib/prisma";
import { AccessDeniedError, type AuthenticatedUser } from "@/modules/access/authorization";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  canEnableForAudience,
  eventModuleCatalog,
  eventModuleDefinition,
  isEventModuleKey,
  type EventModuleContext,
  type EventModuleKey,
} from "@/modules/event-modules/catalog";

export class EventModuleError extends Error {
  constructor(
    message: string,
    public readonly code: "UNKNOWN_MODULE" | "ALWAYS_ON" | "EVENT_NOT_FOUND" | "NOT_APPLICABLE",
  ) {
    super(message);
    this.name = "EventModuleError";
  }
}

const alwaysOnKeys = eventModuleCatalog.filter((definition) => definition.alwaysOn).map((definition) => definition.key);

/** Every module that is on for the event: always-on modules plus stored rows. */
export async function enabledModules(eventId: string): Promise<ReadonlySet<EventModuleKey>> {
  const rows = await getPrisma().eventModule.findMany({ where: { eventId }, select: { moduleKey: true } });
  const enabled = new Set<EventModuleKey>(alwaysOnKeys);
  for (const row of rows) if (isEventModuleKey(row.moduleKey)) enabled.add(row.moduleKey);
  return enabled;
}

/**
 * The modules that are on for each of several events, in one query (the staff
 * shell needs every event's launcher). Always-on modules are included. Stored
 * rows only; `moduleStatesByEvent` adds modules the event's data calls for.
 */
export async function enabledModulesByEvent(eventIds: readonly string[]): Promise<Map<string, ReadonlySet<EventModuleKey>>> {
  const result = new Map<string, Set<EventModuleKey>>(eventIds.map((id) => [id, new Set<EventModuleKey>(alwaysOnKeys)]));
  if (eventIds.length === 0) return result;
  const rows = await getPrisma().eventModule.findMany({
    where: { eventId: { in: [...eventIds] } },
    select: { eventId: true, moduleKey: true },
  });
  for (const row of rows) if (isEventModuleKey(row.moduleKey)) result.get(row.eventId)?.add(row.moduleKey);
  return result;
}

export type EventModuleState = {
  /** Always-on modules plus stored rows: what a system administrator toggles. */
  stored: ReadonlySet<EventModuleKey>;
  /** `stored` plus modules the event's existing data needs. What the launcher and the page show. */
  effective: ReadonlySet<EventModuleKey>;
};

/**
 * Stored rows plus data-driven modules (#741 review), for several events in a
 * fixed number of queries. Merchandise is on for an event with any product (even
 * archived), Seminar assignments for an event that has run an assignment or has
 * a ranked seminar field on any form version. The cheaper checks run first, and
 * an event that already has the row is never checked.
 */
export async function moduleStatesByEvent(eventIds: readonly string[]): Promise<Map<string, EventModuleState>> {
  const stored = await enabledModulesByEvent(eventIds);
  const effective = new Map<string, Set<EventModuleKey>>([...stored].map(([id, keys]) => [id, new Set(keys)]));
  const prisma = getPrisma();
  const lacking = (key: EventModuleKey) => eventIds.filter((id) => !stored.get(id)?.has(key));

  const needsProducts = lacking("merchandise");
  if (needsProducts.length > 0) {
    const rows = await prisma.merchandiseProduct.groupBy({ by: ["eventId"], where: { eventId: { in: needsProducts } } });
    for (const row of rows) effective.get(row.eventId)?.add("merchandise");
  }

  let needsSeminar = lacking("seminar-assignments");
  if (needsSeminar.length > 0) {
    const runs = await prisma.programAssignmentRun.groupBy({ by: ["eventId"], where: { eventId: { in: needsSeminar } } });
    for (const row of runs) effective.get(row.eventId)?.add("seminar-assignments");
    needsSeminar = needsSeminar.filter((id) => !effective.get(id)?.has("seminar-assignments"));
  }
  if (needsSeminar.length > 0) {
    const versions = await prisma.registrationFormVersion.findMany({
      where: { form: { eventId: { in: needsSeminar } } },
      select: { definition: true, form: { select: { eventId: true } } },
    });
    for (const version of versions) {
      if (definitionHasRankedSeminars(version.definition)) effective.get(version.form.eventId)?.add("seminar-assignments");
    }
  }
  return new Map([...stored].map(([id]) => [id, { stored: stored.get(id)!, effective: effective.get(id)! }]));
}

export async function moduleState(eventId: string): Promise<EventModuleState> {
  return (await moduleStatesByEvent([eventId])).get(eventId)!;
}


export async function isModuleEnabled(eventId: string, key: EventModuleKey): Promise<boolean> {
  if (eventModuleDefinition(key).alwaysOn) return true;
  const row = await getPrisma().eventModule.findUnique({
    where: { eventId_moduleKey: { eventId, moduleKey: key } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Whether a stored form definition has a ranked-interest choice field. Reads the
 * raw JSON the same way the migration's backfill does (RANKED_CHOICE with
 * availabilityMode RANKED_INTEREST, or choice limits when the mode is null, empty or missing), so
 * a historic definition that no longer parses strictly still counts.
 */
export function definitionHasRankedSeminars(definition: unknown): boolean {
  const sections = (definition as { sections?: unknown } | null)?.sections;
  if (!Array.isArray(sections)) return false;
  return sections.some((section) => {
    const fields = (section as { fields?: unknown } | null)?.fields;
    return Array.isArray(fields) && fields.some((field) => {
      const candidate = field as { type?: unknown; availabilityMode?: unknown; choiceLimits?: unknown } | null;
      if (candidate?.type !== "RANKED_CHOICE") return false;
      // Same truthiness as `getAvailabilityMode`: a null or empty mode is no mode.
      return candidate.availabilityMode
        ? candidate.availabilityMode === "RANKED_INTEREST"
        : candidate.choiceLimits !== undefined && candidate.choiceLimits !== null;
    });
  });
}

/**
 * The event facts an applicability rule reads. Not called on a request path
 * yet: it costs a lookup of every form version of the event, so a caller
 * should use it only where the seminar rule is actually checked.
 */
export async function loadEventModuleContext(eventId: string): Promise<EventModuleContext> {
  const prisma = getPrisma();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { audience: true } });
  if (!event) throw new EventModuleError("That event does not exist.", "EVENT_NOT_FOUND");
  const ranRun = await prisma.programAssignmentRun.findFirst({ where: { eventId }, select: { id: true } });
  let hasRankedSeminars = ranRun !== null;
  if (!hasRankedSeminars) {
    const versions = await prisma.registrationFormVersion.findMany({
      where: { form: { eventId } },
      select: { definition: true },
    });
    hasRankedSeminars = versions.some((version) => definitionHasRankedSeminars(version.definition));
  }
  return { audience: event.audience, hasRankedSeminars };
}

function requireSystemAdmin(actor: Pick<AuthenticatedUser, "id" | "globalRole"> | null | undefined) {
  if (!actor) throw new AccessDeniedError("Authentication is required.", 401, "AUTHENTICATION_REQUIRED");
  if (actor.globalRole !== "SYSTEM_ADMIN") {
    throw new AccessDeniedError("Only a system administrator can turn event modules on or off.", 403, "PERMISSION_DENIED");
  }
}

function requireKey(key: string): EventModuleKey {
  if (!isEventModuleKey(key)) throw new EventModuleError("That module does not exist.", "UNKNOWN_MODULE");
  return key;
}

/** Turns a module on. System administrators only. Audited with the event id and module key. */
export async function enableModule(
  actor: Pick<AuthenticatedUser, "id" | "globalRole"> | null | undefined,
  eventId: string,
  moduleKey: string,
): Promise<{ changed: boolean }> {
  requireSystemAdmin(actor);
  const key = requireKey(moduleKey);
  if (eventModuleDefinition(key).alwaysOn) return { changed: false };
  return getPrisma().$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true, audience: true } });
    if (!event) throw new EventModuleError("That event does not exist.", "EVENT_NOT_FOUND");
    if (!canEnableForAudience(key, event.audience)) {
      throw new EventModuleError(`${eventModuleDefinition(key).title} applies to club events only.`, "NOT_APPLICABLE");
    }
    const created = await tx.eventModule.createMany({ data: [{ eventId, moduleKey: key }], skipDuplicates: true });
    if (created.count === 0) return { changed: false };
    await writeAuditLog({
      eventId,
      actorUserId: actor!.id,
      action: "EVENT_MODULE_ENABLED",
      entityType: "EventModule",
      entityId: key,
      summary: `Turned on the ${eventModuleDefinition(key).title} module.`,
      metadata: { eventId, moduleKey: key },
    }, tx);
    return { changed: true };
  });
}

/** Turns a module off. System administrators only. Removes the switch only, never the data behind it. */
export async function disableModule(
  actor: Pick<AuthenticatedUser, "id" | "globalRole"> | null | undefined,
  eventId: string,
  moduleKey: string,
): Promise<{ changed: boolean }> {
  requireSystemAdmin(actor);
  const key = requireKey(moduleKey);
  if (eventModuleDefinition(key).alwaysOn) {
    throw new EventModuleError(`${eventModuleDefinition(key).title} is on for every event.`, "ALWAYS_ON");
  }
  return getPrisma().$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true } });
    if (!event) throw new EventModuleError("That event does not exist.", "EVENT_NOT_FOUND");
    const removed = await tx.eventModule.deleteMany({ where: { eventId, moduleKey: key } });
    if (removed.count === 0) return { changed: false };
    await writeAuditLog({
      eventId,
      actorUserId: actor!.id,
      action: "EVENT_MODULE_DISABLED",
      entityType: "EventModule",
      entityId: key,
      summary: `Turned off the ${eventModuleDefinition(key).title} module.`,
      metadata: { eventId, moduleKey: key },
    }, tx);
    return { changed: true };
  });
}
