-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('CHURCH', 'CLUB');

-- CreateEnum
CREATE TYPE "ExternalSystem" AS ENUM ('EADVENTIST', 'ULTRACAMP', 'STERLING', 'CMMS', 'WR26');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "type" "OrganizationType" NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "parentOrganizationId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalIdentity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "personId" TEXT,
    "provider" "ExternalSystem" NOT NULL,
    "providerScope" TEXT NOT NULL DEFAULT '',
    "externalId" TEXT NOT NULL,
    "displayLabel" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExternalIdentity_one_owner_check"
      CHECK (num_nonnulls("organizationId", "personId") = 1)
);

-- CreateIndex
CREATE INDEX "Organization_type_isActive_name_idx" ON "Organization"("type", "isActive", "name");

-- CreateIndex
CREATE INDEX "Organization_parentOrganizationId_isActive_idx" ON "Organization"("parentOrganizationId", "isActive");

-- CreateIndex
CREATE INDEX "Organization_normalizedName_idx" ON "Organization"("normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdentity_provider_providerScope_externalId_key" ON "ExternalIdentity"("provider", "providerScope", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdentity_organizationId_provider_providerScope_key" ON "ExternalIdentity"("organizationId", "provider", "providerScope");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdentity_personId_provider_providerScope_key" ON "ExternalIdentity"("personId", "provider", "providerScope");

-- CreateIndex
CREATE INDEX "ExternalIdentity_organizationId_idx" ON "ExternalIdentity"("organizationId");

-- CreateIndex
CREATE INDEX "ExternalIdentity_personId_idx" ON "ExternalIdentity"("personId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_parentOrganizationId_fkey" FOREIGN KEY ("parentOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
