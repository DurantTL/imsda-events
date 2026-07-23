-- A waitlist request has no payment-method answer. After promotion, the
-- registrant makes an explicit, append-only choice through the private link.
-- Each operation preserves its server quote for exact idempotent replay while
-- Registration.totalAmount remains the authoritative current order total.
CREATE TYPE "RegistrationPaymentChoice" AS ENUM (
  'CARD',
  'PAY_LATER'
);

CREATE TABLE "RegistrationPaymentChoiceOperation" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "registrationId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "expectedPriorOperationId" TEXT,
  "choice" "RegistrationPaymentChoice" NOT NULL,
  "baseSubtotalCents" INTEGER NOT NULL,
  "processingFeeCents" INTEGER NOT NULL,
  "resultingTotalCents" INTEGER NOT NULL,
  "responseSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RegistrationPaymentChoiceOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RegistrationPaymentChoiceOperation_sequence_positive"
    CHECK ("sequence" > 0),
  CONSTRAINT "RegistrationPaymentChoiceOperation_amounts_nonnegative"
    CHECK (
      "baseSubtotalCents" >= 0
      AND "processingFeeCents" >= 0
      AND "resultingTotalCents" >= 0
      AND "resultingTotalCents" = "baseSubtotalCents" + "processingFeeCents"
    )
);

CREATE UNIQUE INDEX "RegistrationPaymentChoiceOperation_registrationId_sequence_key"
ON "RegistrationPaymentChoiceOperation"("registrationId", "sequence");

CREATE UNIQUE INDEX "RegistrationPaymentChoiceOperation_registrationId_clientRequestId_key"
ON "RegistrationPaymentChoiceOperation"("registrationId", "clientRequestId");

CREATE INDEX "RegistrationPaymentChoiceOperation_eventId_createdAt_idx"
ON "RegistrationPaymentChoiceOperation"("eventId", "createdAt");

CREATE INDEX "RegistrationPaymentChoiceOperation_registrationId_createdAt_idx"
ON "RegistrationPaymentChoiceOperation"("registrationId", "createdAt");

ALTER TABLE "RegistrationPaymentChoiceOperation"
ADD CONSTRAINT "RegistrationPaymentChoiceOperation_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "Event"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RegistrationPaymentChoiceOperation"
ADD CONSTRAINT "RegistrationPaymentChoiceOperation_registrationId_fkey"
FOREIGN KEY ("registrationId") REFERENCES "Registration"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "reject_registration_payment_choice_operation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'RegistrationPaymentChoiceOperation rows are immutable';
END;
$$;

CREATE TRIGGER "RegistrationPaymentChoiceOperation_immutable"
BEFORE UPDATE OR DELETE ON "RegistrationPaymentChoiceOperation"
FOR EACH ROW
EXECUTE FUNCTION "reject_registration_payment_choice_operation_mutation"();
