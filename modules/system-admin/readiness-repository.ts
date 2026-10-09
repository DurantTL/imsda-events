import "server-only";

import { readdir } from "node:fs/promises";
import path from "node:path";
import { getServerEnv } from "@/lib/env";
import { logError } from "@/lib/logger";
import { getPrisma } from "@/lib/prisma";
import { getEmailAvailability } from "@/integrations/email/provider";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { isUndeliverableSenderAddress } from "@/modules/events/operational-readiness";
import { getSweepHeartbeat } from "@/modules/operations/sweep-heartbeat-repository";
import { getSquareConfiguration } from "@/modules/payments/square-config-domain";
import { getPlatformSettings } from "./platform-settings";
import { getAutomaticBackupEvidence } from "./readiness-backup";
import {
  automaticBackupKeys,
  evaluateAutomaticChecks,
  type AutomaticReadinessRow,
  type ReadinessFacts,
} from "./readiness-checks";
import {
  findManualReadinessItem,
  manualReadinessGroups,
  manualReadinessItems,
  type ManualReadinessGroup,
} from "./readiness-items";

export const READINESS_NOTE_MAX = 300;

export class ReadinessError extends Error {
  constructor(
    public readonly code: "UNKNOWN_ITEM" | "ALREADY_TICKED" | "NOT_TICKED" | "REASON_REQUIRED" | "NOTE_TOO_LONG",
    message: string,
  ) {
    super(message);
    this.name = "ReadinessError";
  }
}

export type ManualReadinessRow = {
  key: string;
  group: ManualReadinessGroup;
  title: string;
  detail: string;
  reference: string;
  tick: { tickedByName: string; tickedAt: string; note: string | null } | null;
};

export type SystemReadiness = {
  generatedAt: string;
  automatic: AutomaticReadinessRow[];
  groups: Array<{ id: ManualReadinessGroup; title: string; items: ManualReadinessRow[] }>;
  summary: { manualDone: number; manualTotal: number; automaticAttention: number };
};

async function readAdmins(): Promise<ReadinessFacts["admins"]> {
  try {
    const rows = await getPrisma().user.findMany({
      where: { globalRole: "SYSTEM_ADMIN", accountStatus: "ACTIVE" },
      orderBy: { displayName: "asc" },
      select: {
        displayName: true,
        mfaEnrollment: { select: { status: true } },
        passkeys: { where: { revokedAt: null }, select: { id: true }, take: 1 },
      },
    });
    return rows.map((row) => ({
      displayName: row.displayName,
      hasMfaOrPasskey: row.mfaEnrollment?.status === "ACTIVE" || row.passkeys.length > 0,
    }));
  } catch (error) {
    logError("System readiness could not read administrators", error);
    return null;
  }
}

/** Migration folders shipped with this release that the database has not finished applying. */
async function readPendingMigrations(): Promise<string[] | null> {
  try {
    const entries = await readdir(path.join(process.cwd(), "prisma", "migrations"), { withFileTypes: true });
    const shipped = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const applied = await getPrisma().$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const done = new Set(applied.map((row) => row.migration_name));
    return shipped.filter((name) => !done.has(name)).sort();
  } catch (error) {
    logError("System readiness could not read migration status", error);
    return null;
  }
}

async function gatherFacts(now: Date): Promise<ReadinessFacts> {
  const env = getServerEnv();
  const [admins, pendingMigrations, sweep, settings, backup] = await Promise.all([
    readAdmins(),
    readPendingMigrations(),
    getSweepHeartbeat(now).catch((error) => {
      logError("System readiness could not read the sweep heartbeat", error);
      return null;
    }),
    getPlatformSettings().catch(() => null),
    getAutomaticBackupEvidence().catch((error) => {
      logError("System readiness could not read backup status", error);
      return null;
    }),
  ]);
  const senders = [env.ACCOUNT_EMAIL_SENDER_ADDRESS, settings?.defaultSenderEmail].filter(
    (value): value is string => Boolean(value),
  );
  return {
    admins,
    pendingMigrations,
    sweep,
    encryptionKeyConfigured: Boolean(env.SECRET_ENCRYPTION_KEY),
    email: {
      deliveryConfigured: getEmailAvailability().deliveryConfigured,
      senderConfigured: senders.length > 0,
      senderDeliverable: senders.length > 0 && senders.every((sender) => !isUndeliverableSenderAddress(sender)),
    },
    square: {
      environment: getSquareConfiguration().environment,
      productionUnlocked: env.SQUARE_ENABLE_PRODUCTION,
    },
    backup,
  };
}

export async function getSystemReadiness(now = new Date()): Promise<SystemReadiness> {
  const [facts, ticks] = await Promise.all([
    gatherFacts(now),
    getPrisma().systemReadinessTick.findMany(),
  ]);
  const tickByKey = new Map(ticks.map((tick) => [tick.itemKey, tick]));
  const automatic = evaluateAutomaticChecks(facts, now);
  const hidden = automaticBackupKeys(facts.backup);

  const groups = manualReadinessGroups.map((group) => ({
    id: group.id,
    title: group.title,
    items: manualReadinessItems
      .filter((item) => item.group === group.id && !hidden.has(item.key))
      .map((item): ManualReadinessRow => {
        const tick = tickByKey.get(item.key);
        return {
          key: item.key,
          group: item.group,
          title: item.title,
          detail: item.detail,
          reference: item.reference,
          tick: tick
            ? { tickedByName: tick.tickedByName, tickedAt: tick.tickedAt.toISOString(), note: tick.note }
            : null,
        };
      }),
  }));

  const manual = groups.flatMap((group) => group.items);
  return {
    generatedAt: now.toISOString(),
    automatic,
    groups,
    summary: {
      manualDone: manual.filter((item) => item.tick).length,
      manualTotal: manual.length,
      automaticAttention: automatic.filter((row) => row.status === "attention").length,
    },
  };
}

type Actor = { id: string; displayName: string };

function cleanText(value: string | null | undefined) {
  const text = (value ?? "").trim();
  if (text.length > READINESS_NOTE_MAX) {
    throw new ReadinessError("NOTE_TOO_LONG", `Keep it to ${READINESS_NOTE_MAX} characters or fewer.`);
  }
  return text;
}

/**
 * Records that a person did the work. It performs nothing itself. The audit entry carries the item key and the
 * optional note, which the ticker typed and is told not to fill with secrets.
 */
export async function tickReadinessItem(key: string, actor: Actor, note?: string | null) {
  const item = findManualReadinessItem(key);
  if (!item) throw new ReadinessError("UNKNOWN_ITEM", "That checklist item does not exist.");
  const cleanNote = cleanText(note);
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const existing = await tx.systemReadinessTick.findUnique({ where: { itemKey: key } });
    if (existing) throw new ReadinessError("ALREADY_TICKED", "That item is already ticked.");
    await tx.systemReadinessTick.create({
      data: { itemKey: key, tickedByUserId: actor.id, tickedByName: actor.displayName, note: cleanNote || null },
    });
    await writeAuditLog({
      actorUserId: actor.id,
      action: "SYSTEM_READINESS_TICKED",
      entityType: "SystemReadinessItem",
      entityId: key,
      summary: `Ticked system readiness item "${item.title}".`,
      metadata: { itemKey: key, note: cleanNote || null },
    }, tx);
  });
}

/** Removing a tick needs a reason, which is kept only in the audit log. */
export async function untickReadinessItem(key: string, actor: Actor, reason: string | null | undefined) {
  const item = findManualReadinessItem(key);
  if (!item) throw new ReadinessError("UNKNOWN_ITEM", "That checklist item does not exist.");
  const cleanReason = cleanText(reason);
  if (!cleanReason) throw new ReadinessError("REASON_REQUIRED", "Say why this item is being unticked.");
  await getPrisma().$transaction(async (tx) => {
    const existing = await tx.systemReadinessTick.findUnique({ where: { itemKey: key } });
    if (!existing) throw new ReadinessError("NOT_TICKED", "That item is not ticked.");
    await tx.systemReadinessTick.delete({ where: { itemKey: key } });
    await writeAuditLog({
      actorUserId: actor.id,
      action: "SYSTEM_READINESS_UNTICKED",
      entityType: "SystemReadinessItem",
      entityId: key,
      summary: `Unticked system readiness item "${item.title}".`,
      metadata: {
        itemKey: key,
        reason: cleanReason,
        previouslyTickedBy: existing.tickedByName,
        previouslyTickedAt: existing.tickedAt.toISOString(),
      },
    }, tx);
  });
}
