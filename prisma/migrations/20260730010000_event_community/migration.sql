CREATE TYPE "CommunityPostStatus" AS ENUM ('PUBLISHED', 'HIDDEN', 'REMOVED');
CREATE TYPE "CommunityReportReason" AS ENUM ('CONDUCT', 'HARASSMENT', 'PRIVACY', 'SPAM', 'OTHER');
CREATE TYPE "CommunityReportStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');
CREATE TYPE "CommunityNotificationPreference" AS ENUM ('NONE', 'REPLIES', 'ALL');
CREATE TYPE "CommunityNotificationKind" AS ENUM ('NEW_POST', 'REPLY');

CREATE TABLE "EventCommunitySettings" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "allowNewPosts" BOOLEAN NOT NULL DEFAULT true,
    "allowReplies" BOOLEAN NOT NULL DEFAULT true,
    "conductVersion" INTEGER NOT NULL DEFAULT 1,
    "conductText" TEXT NOT NULL DEFAULT 'Be kind, protect privacy, and keep posts focused on the retreat. Do not share another person''s personal information without permission. Event staff may hide content that is unsafe, disruptive, or unrelated to the event.',
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EventCommunitySettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunityParticipation" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "acceptedConductVersion" INTEGER,
    "conductAcceptedAt" TIMESTAMP(3),
    "notificationPreference" "CommunityNotificationPreference" NOT NULL DEFAULT 'REPLIES',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommunityParticipation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunityPost" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "authorAccountId" TEXT NOT NULL,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "status" "CommunityPostStatus" NOT NULL DEFAULT 'PUBLISHED',
    "moderatedAt" TIMESTAMP(3),
    "moderatedByUserId" TEXT,
    "moderationNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommunityPost_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunityReport" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "reporterAccountId" TEXT NOT NULL,
    "reason" "CommunityReportReason" NOT NULL,
    "detail" TEXT,
    "status" "CommunityReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolutionNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommunityReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunityNotification" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "actorAccountId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "kind" "CommunityNotificationKind" NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunityNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventCommunitySettings_eventId_key" ON "EventCommunitySettings"("eventId");
CREATE UNIQUE INDEX "CommunityParticipation_eventId_accountId_key" ON "CommunityParticipation"("eventId", "accountId");
CREATE INDEX "CommunityParticipation_eventId_notificationPreference_idx" ON "CommunityParticipation"("eventId", "notificationPreference");
CREATE INDEX "CommunityPost_eventId_status_createdAt_idx" ON "CommunityPost"("eventId", "status", "createdAt");
CREATE INDEX "CommunityPost_parentId_createdAt_idx" ON "CommunityPost"("parentId", "createdAt");
CREATE INDEX "CommunityPost_authorAccountId_createdAt_idx" ON "CommunityPost"("authorAccountId", "createdAt");
CREATE UNIQUE INDEX "CommunityReport_postId_reporterAccountId_key" ON "CommunityReport"("postId", "reporterAccountId");
CREATE INDEX "CommunityReport_eventId_status_createdAt_idx" ON "CommunityReport"("eventId", "status", "createdAt");
CREATE UNIQUE INDEX "CommunityNotification_recipientAccountId_postId_kind_key" ON "CommunityNotification"("recipientAccountId", "postId", "kind");
CREATE INDEX "CommunityNotification_recipientAccountId_readAt_createdAt_idx" ON "CommunityNotification"("recipientAccountId", "readAt", "createdAt");
CREATE INDEX "CommunityNotification_eventId_createdAt_idx" ON "CommunityNotification"("eventId", "createdAt");

ALTER TABLE "EventCommunitySettings" ADD CONSTRAINT "EventCommunitySettings_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventCommunitySettings" ADD CONSTRAINT "EventCommunitySettings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommunityParticipation" ADD CONSTRAINT "CommunityParticipation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityParticipation" ADD CONSTRAINT "CommunityParticipation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityPost" ADD CONSTRAINT "CommunityPost_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityPost" ADD CONSTRAINT "CommunityPost_authorAccountId_fkey" FOREIGN KEY ("authorAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityPost" ADD CONSTRAINT "CommunityPost_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CommunityPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityPost" ADD CONSTRAINT "CommunityPost_moderatedByUserId_fkey" FOREIGN KEY ("moderatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommunityReport" ADD CONSTRAINT "CommunityReport_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityReport" ADD CONSTRAINT "CommunityReport_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CommunityPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityReport" ADD CONSTRAINT "CommunityReport_reporterAccountId_fkey" FOREIGN KEY ("reporterAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityReport" ADD CONSTRAINT "CommunityReport_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommunityNotification" ADD CONSTRAINT "CommunityNotification_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityNotification" ADD CONSTRAINT "CommunityNotification_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityNotification" ADD CONSTRAINT "CommunityNotification_actorAccountId_fkey" FOREIGN KEY ("actorAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommunityNotification" ADD CONSTRAINT "CommunityNotification_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CommunityPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
