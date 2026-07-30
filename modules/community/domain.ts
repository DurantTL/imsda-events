import { z } from "zod";

export const communityNotificationPreferences = ["NONE", "REPLIES", "ALL"] as const;
export const communityReportReasons = ["CONDUCT", "HARASSMENT", "PRIVACY", "SPAM", "OTHER"] as const;

export const attendeeCommunityActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ACCEPT_CONDUCT") }).strict(),
  z.object({
    action: z.literal("UPDATE_NOTIFICATIONS"),
    preference: z.enum(communityNotificationPreferences),
  }).strict(),
  z.object({
    action: z.literal("CREATE_POST"),
    body: z.string().trim().min(2, "Write at least two characters.").max(1_500),
    parentId: z.string().trim().min(1).max(100).nullable().optional(),
  }).strict(),
  z.object({
    action: z.literal("REPORT_POST"),
    postId: z.string().trim().min(1).max(100),
    reason: z.enum(communityReportReasons),
    detail: z.string().trim().max(500).optional().default(""),
  }).strict(),
  z.object({ action: z.literal("MARK_NOTIFICATIONS_READ") }).strict(),
]);

export const staffCommunityActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("UPDATE_SETTINGS"),
    isEnabled: z.boolean(),
    allowNewPosts: z.boolean(),
    allowReplies: z.boolean(),
    conductText: z.string().trim().min(40).max(4_000),
    retentionDays: z.number().int().min(1).max(365),
  }).strict(),
  z.object({
    action: z.literal("MODERATE_POST"),
    postId: z.string().trim().min(1).max(100),
    status: z.enum(["PUBLISHED", "HIDDEN", "REMOVED"]),
    note: z.string().trim().max(500).optional().default(""),
  }).strict(),
  z.object({
    action: z.literal("RESOLVE_REPORT"),
    reportId: z.string().trim().min(1).max(100),
    status: z.enum(["RESOLVED", "DISMISSED"]),
    note: z.string().trim().max(500).optional().default(""),
  }).strict(),
]);

export type AttendeeCommunityAction = z.infer<typeof attendeeCommunityActionSchema>;
export type StaffCommunityAction = z.infer<typeof staffCommunityActionSchema>;

export const defaultCommunityConduct = "Be kind, protect privacy, and keep posts focused on the retreat. Do not share another person's personal information without permission. Event staff may hide content that is unsafe, disruptive, or unrelated to the event.";
