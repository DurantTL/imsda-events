-- Platform-wide identity and the defaults a new event inherits.
--
-- Exactly one row. The CHECK below is what makes it a singleton rather than a
-- convention: without it, a second row is a silent fork where half the system
-- reads one set of defaults and half reads the other.
CREATE TABLE "PlatformSettings" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "organizationName" TEXT NOT NULL DEFAULT 'IMSDA Events',
    "logoUrl" TEXT,
    "supportContact" TEXT,
    "publicWebsiteUrl" TEXT,
    "defaultTimezone" TEXT NOT NULL DEFAULT 'America/Chicago',
    "defaultSenderName" TEXT NOT NULL DEFAULT 'IMSDA Events',
    "defaultSenderEmail" TEXT,
    "defaultReplyToEmail" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformSettings_singleton" CHECK ("id" = 'platform')
);

ALTER TABLE "PlatformSettings"
    ADD CONSTRAINT "PlatformSettings_updatedByUserId_fkey"
    FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the single row so every reader can assume it exists rather than each
-- one deciding what to do when it does not.
INSERT INTO "PlatformSettings" ("id", "updatedAt") VALUES ('platform', NOW());
