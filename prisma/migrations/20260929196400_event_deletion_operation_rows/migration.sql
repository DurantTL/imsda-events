-- Deleting an event at any stage (#620).
--
-- RegistrationOperation and RegistrationPaymentChoiceOperation are append-only
-- ledgers: a BEFORE UPDATE OR DELETE trigger rejects every change, and their
-- foreign keys to Event, Registration and RegistrationAttendee are RESTRICT.
-- Together those meant an event with a single transfer or substitution could
-- never be deleted. Rows stay immutable for the application in every other
-- case; the only relaxation is that a DELETE is allowed inside a transaction
-- that has set the transaction-local setting `imsda.event_deletion` to 'on',
-- which only the event deletion service does (set_config(..., true) is scoped
-- to that one transaction and cannot leak to a pooled connection's next use).
-- UPDATE stays rejected unconditionally.
--
-- No foreign key changes: the RESTRICT keys are kept, and the deletion service
-- removes these ledger rows explicitly, before their registrations, so the
-- restriction still protects every other delete path.

CREATE OR REPLACE FUNCTION "reject_registration_operation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('imsda.event_deletion', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'RegistrationOperation rows are immutable';
END;
$$;

CREATE OR REPLACE FUNCTION "reject_registration_payment_choice_operation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('imsda.event_deletion', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'RegistrationPaymentChoiceOperation rows are immutable';
END;
$$;
