ALTER TABLE "RegistrationAccessToken"
ADD COLUMN "firstUsedAt" TIMESTAMP(3),
ADD COLUMN "expiryRecordedAt" TIMESTAMP(3);
