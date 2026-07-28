import "server-only";

import { z } from "zod";
import { getPrisma } from "@/lib/prisma";

export const PLATFORM_SETTINGS_ID = "platform";

/**
 * Blank means "not set", not the string "". Storing an empty string would make
 * an unset default indistinguishable from one deliberately cleared, and the
 * inheritance below has to be able to tell those apart.
 */
/**
 * Trims before validating, not after. A pasted address arrives as
 * "  Name@Example.org " often enough that validating first would reject a value
 * the user plainly meant, and a transform that runs afterwards never gets the
 * chance to clean it.
 */
function optionalField<T extends z.ZodType<string>>(inner: T) {
  return z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.union([z.literal(""), inner]),
  ).nullable().optional().transform((value) => (value ? value : null));
}

const optionalEmail = optionalField(
  z.email().max(200).transform((value) => value.toLowerCase()),
);

const optionalUrl = optionalField(z.url().max(500));

export const platformSettingsInputSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  logoUrl: optionalUrl,
  supportContact: optionalEmail,
  publicWebsiteUrl: optionalUrl,
  defaultTimezone: z.string().trim().min(1).max(60),
  defaultSenderName: z.string().trim().min(2).max(120),
  defaultSenderEmail: optionalEmail,
  defaultReplyToEmail: optionalEmail,
}).strict();

export type PlatformSettingsInput = z.infer<typeof platformSettingsInputSchema>;

export type PlatformSettingsRecord = PlatformSettingsInput & {
  updatedAt: string;
  updatedByName: string | null;
};

/**
 * Reads the single settings row, creating it if a database predates the seed.
 *
 * Callers are allowed to assume it exists. Making each one handle its absence
 * would spread the same defaulting decision across every reader, which is how
 * two readers end up disagreeing about what the default is.
 */
export async function getPlatformSettings(): Promise<PlatformSettingsRecord> {
  const prisma = getPrisma();
  const row = await prisma.platformSettings.upsert({
    where: { id: PLATFORM_SETTINGS_ID },
    update: {},
    create: { id: PLATFORM_SETTINGS_ID },
    include: { updatedBy: { select: { displayName: true } } },
  });
  return {
    organizationName: row.organizationName,
    logoUrl: row.logoUrl,
    supportContact: row.supportContact,
    publicWebsiteUrl: row.publicWebsiteUrl,
    defaultTimezone: row.defaultTimezone,
    defaultSenderName: row.defaultSenderName,
    defaultSenderEmail: row.defaultSenderEmail,
    defaultReplyToEmail: row.defaultReplyToEmail,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: row.updatedBy?.displayName ?? null,
  };
}

export async function updatePlatformSettings(
  input: PlatformSettingsInput,
  actorUserId: string,
): Promise<PlatformSettingsRecord> {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const before = await tx.platformSettings.findUnique({
      where: { id: PLATFORM_SETTINGS_ID },
    });
    await tx.platformSettings.upsert({
      where: { id: PLATFORM_SETTINGS_ID },
      update: { ...input, updatedByUserId: actorUserId },
      create: { id: PLATFORM_SETTINGS_ID, ...input, updatedByUserId: actorUserId },
    });
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: "PLATFORM_SETTINGS_UPDATED",
        entityType: "PlatformSettings",
        entityId: PLATFORM_SETTINGS_ID,
        correlationId: `platform-settings:${Date.now()}`,
        summary: `Updated platform settings for ${input.organizationName}.`,
        // Both sides, because "who changed the sender address and what was it
        // before" is the question asked after a delivery goes wrong.
        metadata: {
          before: before
            ? {
              organizationName: before.organizationName,
              defaultSenderEmail: before.defaultSenderEmail,
              defaultReplyToEmail: before.defaultReplyToEmail,
              defaultTimezone: before.defaultTimezone,
            }
            : null,
          after: {
            organizationName: input.organizationName,
            defaultSenderEmail: input.defaultSenderEmail,
            defaultReplyToEmail: input.defaultReplyToEmail,
            defaultTimezone: input.defaultTimezone,
          },
        },
      },
    });
  });
  return getPlatformSettings();
}
