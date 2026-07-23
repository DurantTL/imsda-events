-- Generic staff retries and corrected confirmation resends are both delivery
-- copies of one immutable source message. They must share the same active-child
-- boundary so concurrent actions cannot queue two copies for the same source.
DROP INDEX IF EXISTS "MessageOutbox_active_confirmation_resend_source_key";

CREATE UNIQUE INDEX "MessageOutbox_active_retry_source_key"
ON "MessageOutbox"("retryOfMessageId")
WHERE "retryOfMessageId" IS NOT NULL
  AND "status" IN ('PENDING', 'PROCESSING');
