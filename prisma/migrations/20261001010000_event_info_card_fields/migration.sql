-- Event info cards (#651). Additive only: nullable or defaulted columns, no existing row changes.
ALTER TABLE "Event" ADD COLUMN "tagline" TEXT;
ALTER TABLE "Event" ADD COLUMN "subtitle" TEXT;
ALTER TABLE "Event" ADD COLUMN "helpEmail" TEXT;

ALTER TABLE "HonorOffering" ADD COLUMN "additionalCostCents" INTEGER;
ALTER TABLE "HonorOffering" ADD COLUMN "requirementNote" TEXT NOT NULL DEFAULT '';

ALTER TABLE "HonorOffering" ADD CONSTRAINT "HonorOffering_additionalCostCents_check" CHECK ("additionalCostCents" IS NULL OR "additionalCostCents" > 0);
