-- H3b (#366): a club director reopens and amends their own club's
-- registration through the existing staff amendment engine
-- (modules/registrations/amendments-repository.ts), instead of a staff
-- user amending it. `RegistrationOperation.actorUserId` was a required FK
-- to the staff `User` table, so a director (an `AttendeeAccount`, a
-- separate id space) could never be recorded there. This mirrors the
-- `AttendeeAccountPersonLink` self-service/staff XOR actor shape already in
-- this schema: `actorUserId` becomes optional, and a new optional
-- `actorAttendeeAccountId` records a director actor instead. Exactly one of
-- the two is set for every row, old and new.

ALTER TABLE "RegistrationOperation" ALTER COLUMN "actorUserId" DROP NOT NULL;
ALTER TABLE "RegistrationOperation" ADD COLUMN "actorAttendeeAccountId" TEXT;

ALTER TABLE "RegistrationOperation" ADD CONSTRAINT "RegistrationOperation_actor_check" CHECK (
  ("actorUserId" IS NOT NULL AND "actorAttendeeAccountId" IS NULL)
  OR ("actorUserId" IS NULL AND "actorAttendeeAccountId" IS NOT NULL)
);

CREATE INDEX "RegistrationOperation_actorAttendeeAccountId_createdAt_idx" ON "RegistrationOperation"("actorAttendeeAccountId", "createdAt");

ALTER TABLE "RegistrationOperation" ADD CONSTRAINT "RegistrationOperation_actorAttendeeAccountId_fkey" FOREIGN KEY ("actorAttendeeAccountId") REFERENCES "AttendeeAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
