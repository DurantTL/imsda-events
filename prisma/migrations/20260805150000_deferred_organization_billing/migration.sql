-- ATTENDEE_PAY is the existing behavior. DEFERRED_ORGANIZATION_INVOICE is for
-- club/church group registrations (e.g. Spring Camporee): no attendee balance
-- or online payment is created, and the responsible organization is billed
-- later based on final attendance.
CREATE TYPE "EventBillingMode" AS ENUM (
  'ATTENDEE_PAY',
  'DEFERRED_ORGANIZATION_INVOICE'
);

ALTER TABLE "Event"
ADD COLUMN "billingMode" "EventBillingMode" NOT NULL DEFAULT 'ATTENDEE_PAY';

ALTER TYPE "MessageTemplateKey" ADD VALUE 'REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED';
