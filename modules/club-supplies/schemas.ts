import { z } from "zod";
import { MAX_CLUB_SUPPLY_CSV_BYTES } from "@/modules/club-supplies/catalog-csv";

export const clubSupplyImportSchema = z.object({
  csv: z.string().max(MAX_CLUB_SUPPLY_CSV_BYTES, "That file is too large. Import up to 2,000 rows at a time."),
  confirm: z.boolean().default(false),
  fingerprint: z.string().max(128).optional(),
}).strict();

export const clubSupplyItemActiveSchema = z.object({ isActive: z.boolean() }).strict();

export const clubStockQuantitySchema = z.object({
  quantityOnHand: z.number().int("Enter a whole number.").min(0, "Enter 0 or more.").max(100_000, "Enter 100,000 or fewer."),
}).strict();
