-- CreateEnum
CREATE TYPE "PaymentAttemptChannel" AS ENUM ('EMBEDDED', 'HOSTED_LINK');

-- CreateEnum
CREATE TYPE "SquareHostedCheckoutStatus" AS ENUM ('CREATING', 'ACTIVE', 'PAID', 'INVALIDATED', 'FAILED');

-- CreateEnum
CREATE TYPE "SquareDuplicateChargeStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "hostedPaymentLinkEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "channel" "PaymentAttemptChannel" NOT NULL DEFAULT 'EMBEDDED',
ADD COLUMN     "duplicateReason" TEXT;

-- CreateTable
CREATE TABLE "SquareHostedCheckout" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "paymentAttemptId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" "SquareHostedCheckoutStatus" NOT NULL DEFAULT 'CREATING',
    "providerPaymentLinkId" TEXT,
    "providerOrderId" TEXT,
    "checkoutUrl" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invalidationReason" TEXT,
    "invalidatedAt" TIMESTAMP(3),
    "providerDeletedAt" TIMESTAMP(3),
    "providerDeleteError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SquareHostedCheckout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquareDuplicateCharge" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "paymentAttemptId" TEXT NOT NULL,
    "paymentId" TEXT,
    "providerPaymentId" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "reason" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "winningPaymentId" TEXT,
    "evidence" JSONB NOT NULL,
    "status" "SquareDuplicateChargeStatus" NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SquareDuplicateCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SquareHostedCheckout_paymentAttemptId_key" ON "SquareHostedCheckout"("paymentAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "SquareHostedCheckout_providerPaymentLinkId_key" ON "SquareHostedCheckout"("providerPaymentLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "SquareHostedCheckout_providerOrderId_key" ON "SquareHostedCheckout"("providerOrderId");

-- CreateIndex
CREATE INDEX "SquareHostedCheckout_registrationId_status_idx" ON "SquareHostedCheckout"("registrationId", "status");

-- CreateIndex
CREATE INDEX "SquareHostedCheckout_status_expiresAt_idx" ON "SquareHostedCheckout"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SquareDuplicateCharge_paymentAttemptId_key" ON "SquareDuplicateCharge"("paymentAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "SquareDuplicateCharge_providerPaymentId_key" ON "SquareDuplicateCharge"("providerPaymentId");

-- CreateIndex
CREATE INDEX "SquareDuplicateCharge_eventId_status_idx" ON "SquareDuplicateCharge"("eventId", "status");

-- CreateIndex
CREATE INDEX "SquareDuplicateCharge_registrationId_idx" ON "SquareDuplicateCharge"("registrationId");

-- AddForeignKey
ALTER TABLE "SquareHostedCheckout" ADD CONSTRAINT "SquareHostedCheckout_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquareHostedCheckout" ADD CONSTRAINT "SquareHostedCheckout_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquareHostedCheckout" ADD CONSTRAINT "SquareHostedCheckout_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquareDuplicateCharge" ADD CONSTRAINT "SquareDuplicateCharge_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquareDuplicateCharge" ADD CONSTRAINT "SquareDuplicateCharge_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquareDuplicateCharge" ADD CONSTRAINT "SquareDuplicateCharge_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

