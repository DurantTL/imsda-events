-- Manual refund retry safety (#525). Additive: existing refunds keep a NULL key,
-- and PostgreSQL unique indexes treat NULLs as distinct.
ALTER TABLE "Refund" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Refund_paymentId_idempotencyKey_key" ON "Refund"("paymentId", "idempotencyKey");
