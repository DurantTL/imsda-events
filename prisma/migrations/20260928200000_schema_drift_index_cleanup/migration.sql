-- Schema drift cleanup (#513).
--
-- prisma/schema.prisma's index definitions had drifted from the committed
-- migration history, so a fresh `prisma migrate dev` produced unrelated
-- DROP/RENAME statements for every new migration. This migration brings the
-- database in line with the schema. See docs/SCHEMA-DRIFT-RUNBOOK.md for the
-- full decision record; a short version of the reasoning is inline below.

-- Obsolete narrower indexes, superseded by a wider index that shares the same
-- leading columns (the wider index already serves these lookups, so the
-- narrower one is dead weight kept in sync on every write). schema.prisma
-- stopped declaring these without a matching migration; dropping them here
-- makes production match what the schema has declared since.
DROP INDEX "MerchandiseProduct_eventId_isEnabled_idx";
DROP INDEX "MerchandiseVariantAvailability_variantId_isActive_idx";

-- Pure renames: same columns, same order, same uniqueness — only the stored
-- index name changes. Postgres silently truncates identifiers over 63 bytes,
-- so the name written in the original CREATE INDEX statement was never the
-- name Postgres actually stored; Prisma's own default-name truncation now
-- computes a different (also truncated) name for the same index. No index is
-- dropped or rebuilt, so this is a metadata-only change with no lock beyond a
-- brief catalog update and no query-plan impact.
ALTER INDEX "EventAttendeeClassification_eventId_kind_isActive_sortOrder_lab" RENAME TO "EventAttendeeClassification_eventId_kind_isActive_sortOrder_idx";
ALTER INDEX "MerchandiseVariantAvailability_sales_window_idx" RENAME TO "MerchandiseVariantAvailability_variantId_isActive_salesStar_idx";
ALTER INDEX "MessageOutbox_provider_providerDeliveryStatus_providerStatusAt_" RENAME TO "MessageOutbox_provider_providerDeliveryStatus_providerStatu_idx";
ALTER INDEX "ProgramAssignmentRun_eventId_formVersionId_fieldId_invalidatedA" RENAME TO "ProgramAssignmentRun_eventId_formVersionId_fieldId_invalida_idx";
ALTER INDEX "RegistrationAccessToken_registrationId_purpose_revokedAt_expire" RENAME TO "RegistrationAccessToken_registrationId_purpose_revokedAt_ex_idx";
ALTER INDEX "RegistrationCapacityReservation_formId_fieldId_optionValue_rele" RENAME TO "RegistrationCapacityReservation_formId_fieldId_optionValue__idx";
ALTER INDEX "RegistrationPaymentChoiceOperation_registrationId_clientRequest" RENAME TO "RegistrationPaymentChoiceOperation_registrationId_clientReq_key";

-- Note: PersonMatchCandidate.matchedSignals/contradictingSignals already had
-- DEFAULT ARRAY[]::"PersonMatchSignal"[] in the migration history. That drift
-- was resolved the other direction, by adding @default([]) to schema.prisma
-- instead of dropping the default here, so this migration makes no change to
-- that table.
