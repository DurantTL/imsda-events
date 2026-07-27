import { z } from "zod";
import {
  normalizeExternalId,
  normalizeProviderScope,
} from "@/modules/organizations/domain";

const optionalParentSchema = z.union([
  z.string().trim().min(1).max(100),
  z.literal(""),
  z.null(),
]).optional().transform((value) => value || null);

const organizationShape = {
  name: z.string().trim().min(2).max(160),
  parentOrganizationId: optionalParentSchema,
  isActive: z.boolean().default(true),
};

export const createOrganizationInputSchema = z.object({
  type: z.enum(["CHURCH", "CLUB"]),
  ...organizationShape,
}).strict();

export const updateOrganizationInputSchema = z.object({
  ...organizationShape,
  expectedUpdatedAt: z.iso.datetime(),
}).strict();

const externalIdentityShape = {
  provider: z.enum(["EADVENTIST", "ULTRACAMP", "STERLING", "CMMS", "WR26"]),
  providerScope: z.string().max(120).default("").transform(normalizeProviderScope),
  externalId: z.string().min(1).max(240).transform(normalizeExternalId),
  displayLabel: z.union([
    z.string().trim().min(1).max(160),
    z.literal(""),
    z.null(),
  ]).optional().transform((value) => value || null),
};

export const externalIdentityInputSchema = z.object(
  externalIdentityShape,
).strict();

export const updateExternalIdentityInputSchema = z.object({
  ...externalIdentityShape,
  expectedUpdatedAt: z.iso.datetime(),
}).strict();

export type CreateOrganizationInput = z.infer<
  typeof createOrganizationInputSchema
>;
export type UpdateOrganizationInput = z.infer<
  typeof updateOrganizationInputSchema
>;
export type ExternalIdentityInput = z.infer<
  typeof externalIdentityInputSchema
>;
export type UpdateExternalIdentityInput = z.infer<
  typeof updateExternalIdentityInputSchema
>;
