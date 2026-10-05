import type { LodgingBathroom, LodgingBedType, LodgingCategory, LodgingHoldKind, LodgingUnitKind } from "@/modules/lodging/domain";

/**
 * Property templates (#198) are code data: facility structure only, never
 * people, never prices. Bump `version` when a template changes; the lodging
 * sync applies a template only when its version is newer than the stored one.
 */
export type LodgingUnitSeed = {
  key: string;
  name: string;
  kind: LodgingUnitKind;
  /** A counted area with a capacity but no numbered sites. */
  isArea?: boolean;
  category?: LodgingCategory;
  floor?: number;
  groundLevel?: boolean;
  bathroom?: LodgingBathroom;
  linensProvided?: boolean;
  specialUse?: boolean;
  /** False for storage: never has capacity. */
  assignable?: boolean;
  /** "Sleeps up to". Omit to use the beds; null means no fixed limit. */
  capacity?: number | null;
  beds?: readonly LodgingBedType[];
  /** Unavailable for every event until staff turn it on. Stays in the inventory. */
  defaultUnavailable?: boolean;
  /** A hold placed when an event picks the property (for example kitchen staff). */
  defaultHold?: { kind: LodgingHoldKind; reason: string };
  notes?: string;
};

export type LodgingBuildingSeed = { key: string; name: string; units: readonly LodgingUnitSeed[] };

export type LodgingPropertySeed = {
  key: string;
  name: string;
  version: number;
  buildings: readonly LodgingBuildingSeed[];
};
