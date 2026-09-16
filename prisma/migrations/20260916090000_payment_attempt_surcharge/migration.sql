-- The card processing surcharge carried inside a payment attempt's amount.
--
-- Only ever non-zero for a registration whose total did not already price a
-- card fee in — a pay-later registrant settling their balance by card. The
-- registration total gains this amount when the payment succeeds, not when it
-- is quoted, so an abandoned checkout leaves the balance untouched.
--
-- Existing attempts default to 0: every attempt taken before this column
-- existed was quoted against a total that already included its fee.
ALTER TABLE "PaymentAttempt" ADD COLUMN "surchargeCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_surchargeCents_check"
  CHECK ("surchargeCents" >= 0 AND "surchargeCents" <= "amountCents");
