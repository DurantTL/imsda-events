UPDATE "Registration"
SET "submittedAt" = "createdAt"
WHERE "submittedAt" IS NULL
  AND "status" IN ('SUBMITTED', 'CONFIRMED', 'WAITLISTED');
