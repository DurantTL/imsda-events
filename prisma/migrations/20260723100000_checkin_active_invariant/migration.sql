-- Keep reversible check-in history while allowing only one active arrival row
-- for an attendee. Abort instead of silently rewriting any pre-existing
-- duplicate operational records.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "CheckIn"
    WHERE "undoneAt" IS NULL
    GROUP BY "registrationAttendeeId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce active check-in uniqueness: reconcile duplicate active attendee check-ins first.';
  END IF;
END
$$;

CREATE UNIQUE INDEX "CheckIn_registrationAttendeeId_active_key"
ON "CheckIn"("registrationAttendeeId")
WHERE "undoneAt" IS NULL;

