import { z } from "zod";

const colorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Color must be a 6-digit hex code, e.g. #4F46E5.");

const tagBaseSchema = z.object({
  name: z.string().trim().min(2).max(60),
  color: colorSchema,
  description: z.string().trim().max(300).default(""),
  isActive: z.boolean().default(true),
});

export const tagInputSchema = tagBaseSchema;
export const tagUpdateSchema = tagBaseSchema;

/** One spelling per event: "VIP", "vip", and " VIP " all collide. */
export function normalizedTagName(name: string) {
  return name.trim().toLocaleLowerCase("en-US");
}

export type TagOption = {
  id: string;
  name: string;
  color: string;
  description: string;
  isActive: boolean;
};

export type TagAssignmentRecord = {
  id: string;
  tag: TagOption;
  appliedBy: { id: string; displayName: string };
  appliedAt: string;
  removedBy: { id: string; displayName: string } | null;
  removedAt: string | null;
};
