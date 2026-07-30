import "server-only";

import { randomUUID } from "node:crypto";
import type {
  CommunityNotificationKind,
  CommunityNotificationPreference,
  CommunityPostStatus,
  CommunityReportReason,
  CommunityReportStatus,
  Prisma,
} from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { matchingRegistrationIdsForVerifiedEmail } from "@/modules/attendee-accounts/registrations-repository";
import { defaultCommunityConduct } from "@/modules/community/domain";

const activeRegistrationStatuses = ["SUBMITTED", "CONFIRMED"] as const;

export class CommunityError extends Error {
  constructor(
    public readonly code:
      | "COMMUNITY_NOT_FOUND"
      | "COMMUNITY_DISABLED"
      | "COMMUNITY_CONDUCT_REQUIRED"
      | "COMMUNITY_POSTS_DISABLED"
      | "COMMUNITY_REPLIES_DISABLED"
      | "COMMUNITY_POST_NOT_FOUND"
      | "COMMUNITY_ALREADY_REPORTED",
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

type AttendeeIdentity = {
  id: string;
  verifiedEmail: string;
  displayName: string;
};

const defaultSettings = {
  isEnabled: false,
  allowNewPosts: true,
  allowReplies: true,
  conductVersion: 1,
  conductText: defaultCommunityConduct,
  retentionDays: 30,
};

function settingsRecord(settings: {
  isEnabled: boolean;
  allowNewPosts: boolean;
  allowReplies: boolean;
  conductVersion: number;
  conductText: string;
  retentionDays: number;
} | null) {
  return settings ?? defaultSettings;
}

async function attendeeEventAccess(account: AttendeeIdentity, eventIdOrSlug: {
  id?: string;
  slug?: string;
}) {
  const registrationIds = await matchingRegistrationIdsForVerifiedEmail(account.verifiedEmail);
  if (registrationIds.length === 0) {
    throw new CommunityError("COMMUNITY_NOT_FOUND", "No active retreat registration was found.", 404);
  }
  const event = await getPrisma().event.findFirst({
    where: {
      ...eventIdOrSlug,
      isPublished: true,
      registrations: {
        some: {
          id: { in: registrationIds },
          status: { in: [...activeRegistrationStatuses] },
        },
      },
    },
    select: {
      id: true,
      slug: true,
      name: true,
      endsAt: true,
      communitySettings: true,
    },
  });
  if (!event) {
    throw new CommunityError("COMMUNITY_NOT_FOUND", "No active retreat registration was found.", 404);
  }
  return event;
}

type CommunityPostRecord = {
  id: string;
  parentId: string | null;
  body: string;
  status: CommunityPostStatus;
  createdAt: string;
  authorName: string;
  isOwn: boolean;
  isReported: boolean;
  replies: CommunityPostRecord[];
};

function postRecord(post: {
  id: string;
  parentId: string | null;
  body: string;
  status: CommunityPostStatus;
  createdAt: Date;
  authorAccountId: string;
  author: { displayName: string };
  reports?: Array<{ id: string }>;
  replies?: Array<{
    id: string;
    parentId: string | null;
    body: string;
    status: CommunityPostStatus;
    createdAt: Date;
    authorAccountId: string;
    author: { displayName: string };
    reports?: Array<{ id: string }>;
  }>;
}, accountId: string): CommunityPostRecord {
  const visibleBody = post.status === "PUBLISHED"
    ? post.body
    : post.status === "HIDDEN"
      ? "This post was hidden by the event team."
      : "This post was removed.";
  return {
    id: post.id,
    parentId: post.parentId,
    body: visibleBody,
    status: post.status,
    createdAt: post.createdAt.toISOString(),
    authorName: post.author.displayName,
    isOwn: post.authorAccountId === accountId,
    isReported: Boolean(post.reports?.length),
    replies: post.replies?.map((reply) => postRecord(reply, accountId)) ?? [],
  };
}

export async function getAttendeeCommunity(
  account: AttendeeIdentity,
  eventSlug: string,
) {
  let event;
  try {
    event = await attendeeEventAccess(account, { slug: eventSlug });
  } catch (error) {
    if (error instanceof CommunityError && error.code === "COMMUNITY_NOT_FOUND") return null;
    throw error;
  }
  const settings = settingsRecord(event.communitySettings);
  const [participation, posts, notifications] = await Promise.all([
    getPrisma().communityParticipation.findUnique({
      where: { eventId_accountId: { eventId: event.id, accountId: account.id } },
    }),
    settings.isEnabled
      ? getPrisma().communityPost.findMany({
          where: { eventId: event.id, parentId: null },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: {
            id: true,
            parentId: true,
            body: true,
            status: true,
            createdAt: true,
            authorAccountId: true,
            author: { select: { displayName: true } },
            reports: { where: { reporterAccountId: account.id }, select: { id: true } },
            replies: {
              orderBy: { createdAt: "asc" },
              take: 100,
              select: {
                id: true,
                parentId: true,
                body: true,
                status: true,
                createdAt: true,
                authorAccountId: true,
                author: { select: { displayName: true } },
                reports: { where: { reporterAccountId: account.id }, select: { id: true } },
              },
            },
          },
        })
      : Promise.resolve([]),
    settings.isEnabled
      ? getPrisma().communityNotification.findMany({
          where: { eventId: event.id, recipientAccountId: account.id },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            kind: true,
            readAt: true,
            createdAt: true,
            actor: { select: { displayName: true } },
            post: { select: { id: true, body: true, status: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  return {
    eventId: event.id,
    eventName: event.name,
    settings,
    participation: {
      conductAccepted: participation?.acceptedConductVersion === settings.conductVersion,
      notificationPreference: participation?.notificationPreference ?? "REPLIES",
    },
    posts: posts.map((post) => postRecord(post, account.id)),
    notifications: notifications.map((notification) => ({
      id: notification.id,
      kind: notification.kind,
      read: Boolean(notification.readAt),
      createdAt: notification.createdAt.toISOString(),
      actorName: notification.actor.displayName,
      postId: notification.post.id,
      excerpt: notification.post.status === "PUBLISHED"
        ? notification.post.body.slice(0, 120)
        : "This community post is no longer visible.",
    })),
  };
}

export async function getStaffCommunity(eventId: string) {
  const event = await getPrisma().event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      slug: true,
      name: true,
      communitySettings: true,
      communityPosts: {
        where: { parentId: null },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          parentId: true,
          body: true,
          status: true,
          moderationNote: true,
          createdAt: true,
          authorAccountId: true,
          author: { select: { displayName: true, email: true } },
          reports: { where: { status: "OPEN" }, select: { id: true } },
          replies: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              parentId: true,
              body: true,
              status: true,
              moderationNote: true,
              createdAt: true,
              authorAccountId: true,
              author: { select: { displayName: true, email: true } },
              reports: { where: { status: "OPEN" }, select: { id: true } },
            },
          },
        },
      },
      communityReports: {
        where: { status: "OPEN" },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          postId: true,
          reason: true,
          detail: true,
          createdAt: true,
          reporter: { select: { displayName: true, email: true } },
          post: {
            select: {
              body: true,
              status: true,
              author: { select: { displayName: true, email: true } },
            },
          },
        },
      },
      _count: { select: { communityParticipations: true } },
    },
  });
  if (!event) return null;
  const settings = settingsRecord(event.communitySettings);
  const staffPost = (post: typeof event.communityPosts[number] | typeof event.communityPosts[number]["replies"][number]) => ({
    id: post.id,
    parentId: post.parentId,
    body: post.body,
    status: post.status,
    moderationNote: post.moderationNote,
    createdAt: post.createdAt.toISOString(),
    authorName: post.author.displayName,
    authorEmail: post.author.email,
    openReports: post.reports.length,
  });
  return {
    eventId: event.id,
    eventSlug: event.slug,
    eventName: event.name,
    settings,
    participantCount: event._count.communityParticipations,
    posts: event.communityPosts.map((post) => ({
      ...staffPost(post),
      replies: post.replies.map(staffPost),
    })),
    reports: event.communityReports.map((report) => ({
      id: report.id,
      postId: report.postId,
      reason: report.reason,
      detail: report.detail,
      createdAt: report.createdAt.toISOString(),
      reporterName: report.reporter.displayName,
      reporterEmail: report.reporter.email,
      authorName: report.post.author.displayName,
      authorEmail: report.post.author.email,
      postBody: report.post.body,
      postStatus: report.post.status,
    })),
  };
}

async function upsertParticipation(
  eventId: string,
  accountId: string,
  data: {
    acceptedConductVersion?: number;
    conductAcceptedAt?: Date;
    notificationPreference?: CommunityNotificationPreference;
  },
) {
  return getPrisma().communityParticipation.upsert({
    where: { eventId_accountId: { eventId, accountId } },
    create: { eventId, accountId, ...data },
    update: data,
  });
}

export async function acceptCommunityConduct(account: AttendeeIdentity, eventId: string) {
  const event = await attendeeEventAccess(account, { id: eventId });
  const settings = settingsRecord(event.communitySettings);
  if (!settings.isEnabled) {
    throw new CommunityError("COMMUNITY_DISABLED", "The attendee community is not enabled.", 409);
  }
  await upsertParticipation(event.id, account.id, {
    acceptedConductVersion: settings.conductVersion,
    conductAcceptedAt: new Date(),
  });
}

export async function updateCommunityNotifications(
  account: AttendeeIdentity,
  eventId: string,
  preference: CommunityNotificationPreference,
) {
  await attendeeEventAccess(account, { id: eventId });
  await upsertParticipation(eventId, account.id, { notificationPreference: preference });
}

async function requirePostingParticipation(
  tx: Prisma.TransactionClient,
  eventId: string,
  accountId: string,
  conductVersion: number,
) {
  const participation = await tx.communityParticipation.findUnique({
    where: { eventId_accountId: { eventId, accountId } },
  });
  if (participation?.acceptedConductVersion !== conductVersion) {
    throw new CommunityError(
      "COMMUNITY_CONDUCT_REQUIRED",
      "Accept the current community conduct agreement before posting.",
      409,
    );
  }
}

export async function createCommunityPost(
  account: AttendeeIdentity,
  eventId: string,
  input: { body: string; parentId?: string | null },
) {
  const event = await attendeeEventAccess(account, { id: eventId });
  const settings = settingsRecord(event.communitySettings);
  if (!settings.isEnabled) throw new CommunityError("COMMUNITY_DISABLED", "The attendee community is not enabled.", 409);
  if (input.parentId ? !settings.allowReplies : !settings.allowNewPosts) {
    throw new CommunityError(
      input.parentId ? "COMMUNITY_REPLIES_DISABLED" : "COMMUNITY_POSTS_DISABLED",
      input.parentId ? "Replies are currently paused." : "New posts are currently paused.",
      409,
    );
  }

  return getPrisma().$transaction(async (tx) => {
    await requirePostingParticipation(tx, event.id, account.id, settings.conductVersion);
    const parent = input.parentId
      ? await tx.communityPost.findFirst({
          where: { id: input.parentId, eventId: event.id, parentId: null, status: "PUBLISHED" },
          select: { id: true, authorAccountId: true },
        })
      : null;
    if (input.parentId && !parent) {
      throw new CommunityError("COMMUNITY_POST_NOT_FOUND", "That post is no longer available.", 404);
    }
    const post = await tx.communityPost.create({
      data: {
        eventId: event.id,
        authorAccountId: account.id,
        parentId: parent?.id,
        body: input.body,
      },
    });
    const participants = await tx.communityParticipation.findMany({
      where: {
        eventId: event.id,
        accountId: { not: account.id },
        notificationPreference: parent
          ? { in: ["REPLIES", "ALL"] }
          : "ALL",
      },
      select: { accountId: true, notificationPreference: true },
    });
    const recipients = participants
      .filter((participant) => (
        participant.notificationPreference === "ALL"
        || (parent && participant.accountId === parent.authorAccountId)
      ))
      .map((participant) => participant.accountId);
    if (recipients.length > 0) {
      await tx.communityNotification.createMany({
        data: recipients.map((recipientAccountId) => ({
          eventId: event.id,
          recipientAccountId,
          actorAccountId: account.id,
          postId: post.id,
          kind: (parent ? "REPLY" : "NEW_POST") as CommunityNotificationKind,
        })),
        skipDuplicates: true,
      });
    }
    await tx.auditLog.create({
      data: {
        eventId: event.id,
        action: parent ? "COMMUNITY_REPLY_CREATED" : "COMMUNITY_POST_CREATED",
        entityType: "CommunityPost",
        entityId: post.id,
        correlationId: randomUUID(),
        summary: `${account.displayName} added ${parent ? "a reply" : "a community post"}.`,
        metadata: { attendeeAccountId: account.id, parentId: parent?.id ?? null },
      },
    });
    return post;
  });
}

export async function reportCommunityPost(
  account: AttendeeIdentity,
  eventId: string,
  input: { postId: string; reason: CommunityReportReason; detail?: string },
) {
  const event = await attendeeEventAccess(account, { id: eventId });
  if (!settingsRecord(event.communitySettings).isEnabled) {
    throw new CommunityError("COMMUNITY_DISABLED", "The attendee community is not enabled.", 409);
  }
  const post = await getPrisma().communityPost.findFirst({
    where: { id: input.postId, eventId, status: "PUBLISHED" },
    select: { id: true },
  });
  if (!post) throw new CommunityError("COMMUNITY_POST_NOT_FOUND", "That post is no longer available.", 404);
  try {
    return await getPrisma().$transaction(async (tx) => {
      const report = await tx.communityReport.create({
        data: {
          eventId,
          postId: post.id,
          reporterAccountId: account.id,
          reason: input.reason,
          detail: input.detail || null,
        },
      });
      await tx.auditLog.create({
        data: {
          eventId,
          action: "COMMUNITY_POST_REPORTED",
          entityType: "CommunityReport",
          entityId: report.id,
          correlationId: randomUUID(),
          summary: "A community post was reported for staff review.",
          metadata: { attendeeAccountId: account.id, postId: post.id, reason: input.reason },
        },
      });
      return report;
    });
  } catch (error) {
    if (
      typeof error === "object"
      && error
      && "code" in error
      && error.code === "P2002"
    ) {
      throw new CommunityError("COMMUNITY_ALREADY_REPORTED", "You already reported this post.", 409);
    }
    throw error;
  }
}

export async function markCommunityNotificationsRead(account: AttendeeIdentity, eventId: string) {
  await attendeeEventAccess(account, { id: eventId });
  return getPrisma().communityNotification.updateMany({
    where: { eventId, recipientAccountId: account.id, readAt: null },
    data: { readAt: new Date() },
  });
}

export async function updateCommunitySettings(
  eventId: string,
  actorUserId: string,
  input: {
    isEnabled: boolean;
    allowNewPosts: boolean;
    allowReplies: boolean;
    conductText: string;
    retentionDays: number;
  },
) {
  const existing = await getPrisma().eventCommunitySettings.findUnique({ where: { eventId } });
  const conductChanged = Boolean(existing && existing.conductText !== input.conductText);
  return getPrisma().$transaction(async (tx) => {
    const settings = await tx.eventCommunitySettings.upsert({
      where: { eventId },
      create: { eventId, updatedByUserId: actorUserId, ...input },
      update: {
        ...input,
        updatedByUserId: actorUserId,
        ...(conductChanged ? { conductVersion: { increment: 1 } } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "COMMUNITY_SETTINGS_UPDATED",
        entityType: "EventCommunitySettings",
        entityId: settings.id,
        correlationId: randomUUID(),
        summary: `Community ${settings.isEnabled ? "enabled" : "disabled"}; posts ${settings.allowNewPosts ? "open" : "paused"}; replies ${settings.allowReplies ? "open" : "paused"}.`,
        metadata: {
          conductVersion: settings.conductVersion,
          retentionDays: settings.retentionDays,
        },
      },
    });
    return settings;
  });
}

export async function moderateCommunityPost(
  eventId: string,
  actorUserId: string,
  input: { postId: string; status: CommunityPostStatus; note?: string },
) {
  const post = await getPrisma().communityPost.findFirst({
    where: { id: input.postId, eventId },
    select: { id: true },
  });
  if (!post) throw new CommunityError("COMMUNITY_POST_NOT_FOUND", "That post does not exist.", 404);
  return getPrisma().$transaction(async (tx) => {
    const updated = await tx.communityPost.update({
      where: { id: post.id },
      data: {
        status: input.status,
        moderatedAt: new Date(),
        moderatedByUserId: actorUserId,
        moderationNote: input.note || null,
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "COMMUNITY_POST_MODERATED",
        entityType: "CommunityPost",
        entityId: post.id,
        correlationId: randomUUID(),
        summary: `Community post marked ${input.status.toLowerCase()}.`,
        metadata: { note: input.note || null },
      },
    });
    return updated;
  });
}

export async function resolveCommunityReport(
  eventId: string,
  actorUserId: string,
  input: { reportId: string; status: Exclude<CommunityReportStatus, "OPEN">; note?: string },
) {
  const report = await getPrisma().communityReport.findFirst({
    where: { id: input.reportId, eventId },
    select: { id: true },
  });
  if (!report) throw new CommunityError("COMMUNITY_POST_NOT_FOUND", "That report does not exist.", 404);
  return getPrisma().$transaction(async (tx) => {
    const resolved = await tx.communityReport.update({
      where: { id: report.id },
      data: {
        status: input.status,
        resolutionNote: input.note || null,
        resolvedAt: new Date(),
        resolvedByUserId: actorUserId,
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "COMMUNITY_REPORT_RESOLVED",
        entityType: "CommunityReport",
        entityId: report.id,
        correlationId: randomUUID(),
        summary: `Community report marked ${input.status.toLowerCase()}.`,
        metadata: { note: input.note || null },
      },
    });
    return resolved;
  });
}

/**
 * Retention is measured from the event end, not from each post. The existing
 * authenticated sweep invokes this routinely, so no second scheduler or secret
 * is introduced. Cascades remove replies, reports, and notifications together.
 */
export async function pruneExpiredCommunityContent(now = new Date()) {
  const settings = await getPrisma().eventCommunitySettings.findMany({
    select: { eventId: true, retentionDays: true, event: { select: { endsAt: true } } },
  });
  let removedPosts = 0;
  for (const setting of settings) {
    const expiresAt = new Date(
      setting.event.endsAt.getTime() + setting.retentionDays * 24 * 60 * 60 * 1_000,
    );
    if (expiresAt > now) continue;
    const result = await getPrisma().communityPost.deleteMany({ where: { eventId: setting.eventId } });
    removedPosts += result.count;
  }
  return { removedPosts };
}
