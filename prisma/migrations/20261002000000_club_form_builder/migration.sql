-- Club form builder (#712). A template can be edited in the app: a draft is
-- kept on the template row, and publishing bumps `version` and records a frozen
-- copy of that version so older submissions keep rendering against theirs.
-- `customizedAt` tells `club-forms:sync` to leave an edited template alone.
ALTER TABLE "ClubFormTemplate" ADD COLUMN "hiddenFieldKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ClubFormTemplate" ADD COLUMN "customizedAt" TIMESTAMP(3);
ALTER TABLE "ClubFormTemplate" ADD COLUMN "draft" JSONB;
ALTER TABLE "ClubFormTemplate" ADD COLUMN "draftUpdatedAt" TIMESTAMP(3);
ALTER TABLE "ClubFormTemplate" ADD COLUMN "draftUpdatedByUserId" TEXT;

CREATE TABLE "ClubFormTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "definition" JSONB NOT NULL,
    "sectionNotes" JSONB NOT NULL DEFAULT '{}',
    "sensitiveFieldKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "birthDateFieldKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "staffOnlyFieldKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hiddenFieldKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "printLayout" TEXT NOT NULL DEFAULT 'STANDARD',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubFormTemplateVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClubFormTemplateVersion_templateId_version_key" ON "ClubFormTemplateVersion"("templateId", "version");

ALTER TABLE "ClubFormTemplateVersion" ADD CONSTRAINT "ClubFormTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ClubFormTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The version each template is on today becomes its first recorded version.
INSERT INTO "ClubFormTemplateVersion" ("id", "templateId", "version", "name", "description", "definition", "sectionNotes", "sensitiveFieldKeys", "birthDateFieldKeys", "staffOnlyFieldKeys", "printLayout")
SELECT 'cfv_' || md5("id" || ':' || "version"::text), "id", "version", "name", "description", "definition", "sectionNotes", "sensitiveFieldKeys", "birthDateFieldKeys", "staffOnlyFieldKeys", "printLayout"
FROM "ClubFormTemplate";
