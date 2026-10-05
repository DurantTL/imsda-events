import "server-only";

import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { bedSleeps } from "@/modules/lodging/domain";
import { lodgingPropertyTemplates, seedCapacity, type LodgingPropertySeed } from "@/modules/lodging/templates";

export type LodgingSyncResult = {
  applied: Array<{ key: string; version: number; units: number }>;
  unchanged: Array<{ key: string; version: number }>;
};

const syncLockKey = "lodging-template-sync";

/**
 * Brings every property template up to the version in the code (#198). A
 * template is applied only when its version is newer than the stored one, so
 * the sync is safe to run on every deploy; it is serialized by an advisory
 * lock so two deploys cannot interleave. Units a newer template no longer
 * lists are retired, never deleted (events may reference them). Per-event
 * state (overrides, holds, rates) is never touched.
 */
export async function syncLodgingTemplates(
  client: PrismaClient = getPrisma(),
  templates: readonly LodgingPropertySeed[] = lodgingPropertyTemplates,
): Promise<LodgingSyncResult> {
  const result: LodgingSyncResult = { applied: [], unchanged: [] };
  await client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${syncLockKey}))`;
    for (const seed of templates) {
      const stored = await tx.lodgingProperty.findUnique({ where: { key: seed.key }, select: { id: true, templateVersion: true } });
      if (stored && stored.templateVersion >= seed.version) {
        result.unchanged.push({ key: seed.key, version: stored.templateVersion });
        continue;
      }
      const property = await tx.lodgingProperty.upsert({
        where: { key: seed.key },
        create: { key: seed.key, name: seed.name, templateVersion: seed.version },
        update: { name: seed.name, templateVersion: seed.version },
      });
      let unitCount = 0;
      const listedUnitKeys: string[] = [];
      for (const [buildingIndex, building] of seed.buildings.entries()) {
        const row = await tx.lodgingBuilding.upsert({
          where: { propertyId_key: { propertyId: property.id, key: building.key } },
          create: { propertyId: property.id, key: building.key, name: building.name, sortOrder: buildingIndex },
          update: { name: building.name, sortOrder: buildingIndex },
        });
        for (const [unitIndex, unit] of building.units.entries()) {
          listedUnitKeys.push(unit.key);
          unitCount += 1;
          const data = {
            buildingId: row.id,
            name: unit.name,
            kind: unit.kind,
            isArea: unit.isArea ?? false,
            category: unit.category ?? null,
            floor: unit.floor ?? null,
            groundLevel: unit.groundLevel ?? false,
            bathroom: unit.bathroom ?? "UNSPECIFIED",
            linensProvided: unit.linensProvided ?? null,
            specialUse: unit.specialUse ?? false,
            assignable: unit.assignable ?? true,
            defaultCapacity: seedCapacity(unit),
            defaultUnavailable: unit.defaultUnavailable ?? false,
            defaultHoldKind: unit.defaultHold?.kind ?? null,
            defaultHoldReason: unit.defaultHold?.reason ?? null,
            notes: unit.notes ?? null,
            sortOrder: unitIndex,
            retiredAt: null,
          } satisfies Prisma.LodgingUnitUncheckedUpdateInput;
          const unitRow = await tx.lodgingUnit.upsert({
            where: { propertyId_key: { propertyId: property.id, key: unit.key } },
            create: { propertyId: property.id, key: unit.key, ...data },
            update: data,
          });
          await tx.lodgingBed.deleteMany({ where: { unitId: unitRow.id } });
          const beds = unit.beds ?? [];
          if (beds.length > 0) {
            await tx.lodgingBed.createMany({
              data: beds.map((type, position) => ({ unitId: unitRow.id, position, type, sleeps: bedSleeps[type] })),
            });
          }
        }
      }
      await tx.lodgingUnit.updateMany({
        where: { propertyId: property.id, key: { notIn: listedUnitKeys }, retiredAt: null },
        data: { retiredAt: new Date() },
      });
      result.applied.push({ key: seed.key, version: seed.version, units: unitCount });
    }
  }, { timeout: 60_000 });
  return result;
}
