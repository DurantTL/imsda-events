import { sleepsFromBeds } from "@/modules/lodging/domain";
import { campHeritageTemplate } from "@/modules/lodging/templates/camp-heritage";
import { sunnydaleTemplate } from "@/modules/lodging/templates/sunnydale";
import type { LodgingPropertySeed, LodgingUnitSeed } from "@/modules/lodging/templates/types";

export const lodgingPropertyTemplates: readonly LodgingPropertySeed[] = [campHeritageTemplate, sunnydaleTemplate];

/** "Sleeps up to" for a seed: its explicit figure (null is no fixed limit) or what its beds sleep. */
export function seedCapacity(unit: LodgingUnitSeed): number | null {
  if (unit.capacity !== undefined) return unit.capacity;
  return sleepsFromBeds(unit.beds ?? []);
}

export type { LodgingBuildingSeed, LodgingPropertySeed, LodgingUnitSeed } from "@/modules/lodging/templates/types";
