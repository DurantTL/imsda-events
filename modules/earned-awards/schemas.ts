import { z } from "zod";
import { type ClubClassLevel, clubClassLevels, parseCalendarDate } from "@/modules/club-rosters/domain";
import { MAX_AWARD_ITEMS, MAX_AWARD_MEMBERS, MAX_AWARD_NEEDS_PER_ENTRY } from "@/modules/earned-awards/domain";
import { MAX_MASTER_AWARD_RULES_FILE_BYTES } from "@/modules/earned-awards/master-award-import";

const id = z.string().min(1).max(64);

/**
 * Recording earned awards by hand (#532): "these 6 members each earned a
 * Good Conduct Bar" is 6 person ids and 1 catalog item id. `alreadyHasIt` is
 * the spreadsheet's "already has it": recorded as awarded without touching
 * stock.
 */
export const recordAwardNeedsSchema = z
  .object({
    personIds: z.array(id).min(1).max(MAX_AWARD_MEMBERS),
    itemIds: z.array(id).min(1).max(MAX_AWARD_ITEMS),
    alreadyHasIt: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.personIds).size * new Set(value.itemIds).size > MAX_AWARD_NEEDS_PER_ENTRY) {
      context.addIssue({ code: "custom", message: `Record at most ${MAX_AWARD_NEEDS_PER_ENTRY} items at a time.` });
    }
  });

export type RecordAwardNeedsInput = z.infer<typeof recordAwardNeedsSchema>;

const calendarDate = z.string().refine((value) => parseCalendarDate(value) !== null, "Enter the date the class was completed.");

/** Marking members as having completed a class (#532): the signal that suggests that class's insignia. */
export const recordClassCompletionsSchema = z
  .object({
    personIds: z.array(id).min(1).max(MAX_AWARD_MEMBERS),
    classLevel: z.enum(clubClassLevels as [ClubClassLevel, ...ClubClassLevel[]]),
    completedOn: calendarDate,
  })
  .strict();

/** Confirming suggested insignia (#532): per completion, exactly the items the director left ticked. */
export const confirmInsigniaSchema = z
  .object({
    confirmations: z
      .array(z.object({ completionId: id, itemIds: z.array(id).min(1).max(MAX_AWARD_ITEMS) }).strict())
      .min(1)
      .max(MAX_AWARD_MEMBERS),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const entry of value.confirmations) {
      if (seen.has(entry.completionId)) context.addIssue({ code: "custom", message: "Each class can be confirmed only once at a time." });
      seen.add(entry.completionId);
    }
  });

export const dismissInsigniaSchema = z
  .object({ completionIds: z.array(id).min(1).max(MAX_AWARD_MEMBERS) })
  .strict();

/** Confirming a suggested event patch (#532): one event and item, for the attendees the director left ticked. */
export const confirmEventPatchesSchema = z
  .object({ eventId: id, itemId: id, personIds: z.array(id).min(1).max(MAX_AWARD_MEMBERS) })
  .strict();

/** Adding a Master Award for members who reached its requirements (#532). */
export const addMasterAwardsSchema = z
  .object({ ruleId: id, personIds: z.array(id).min(1).max(MAX_AWARD_MEMBERS) })
  .strict();

/** Linking a catalog item to a club event (#532). */
export const eventAwardItemSchema = z.object({ itemId: id }).strict();

/** The Master Award rules import (#532): `confirm: false` is the dry run and returns a fingerprint. */
export const masterAwardRulesImportSchema = z
  .object({
    json: z.string().max(MAX_MASTER_AWARD_RULES_FILE_BYTES, "That file is too large."),
    confirm: z.boolean().default(false),
    fingerprint: z.string().max(128).optional(),
  })
  .strict();

/**
 * A system administrator's edit of one rule (#532). Groups are replaced as a
 * whole (each group's minimum and honor list); `needsManualCheck` can only
 * be cleared here by saying so on purpose.
 */
export const masterAwardRuleUpdateSchema = z
  .object({
    groups: z
      .array(z.object({
        minimum: z.number().int("Enter a whole number.").min(1, "A group needs a minimum of at least 1.").max(100),
        honorIds: z.array(id).min(1, "Add at least one honor to each group.").max(300),
      }).strict())
      .min(1, "Add at least one honor group.")
      .max(10)
      .optional(),
    itemId: id.nullable().optional(),
    reviewNote: z.string().max(1000).optional(),
    needsManualCheck: z.boolean().optional(),
    status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change.");

export type MasterAwardRuleUpdate = z.infer<typeof masterAwardRuleUpdateSchema>;
