# Graph Report - IMSDA Events  (2026-07-27)

## Corpus Check
- 426 files · ~231,506 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2766 nodes · 7006 edges · 189 communities (156 shown, 33 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 181 edges (avg confidence: 0.63)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `90cd6c08`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- checkin/domain.ts
- program-assignments/repository.ts
- payment-choice-repository.ts
- operational-reports.ts
- email-delivery.ts
- request-security.ts
- promo-codes/repository.ts
- registration-builder-workspace.tsx
- events/repository.ts
- event-settings-workspace.tsx
- attendee-pass-repository.ts
- RegistrationFormDefinition
- forms/public-repository.ts
- public-registration-form.tsx
- imports/repository.ts
- forms/public-domain.ts
- getCurrentSession
- lifecycle-repository.ts
- square-repository.ts
- operations-repository.ts
- messaging-repository.ts
- templates.ts
- compilerOptions
- public-access/repository.ts
- access/authorization.ts
- hashOpaqueToken
- resolveEventContext
- transactional-messages.ts
- events/public-domain.ts
- reminder-audience.ts
- devDependencies
- check-in/route.ts
- communications-workspace.tsx
- square-domain.ts
- membership-rules.ts
- square-payment-repository.test.ts
- operational-health.ts
- [action]/route.ts
- service.ts
- registrations/repository.ts
- scripts
- organizations/repository.ts
- registration-operation-routes.test.ts
- payment/route.ts
- public-registration-access-route.test.ts
- dependencies
- registration-attendee-route.test.ts
- message-retry-repository.test.ts
- [token]/page.tsx
- brand-mark.tsx
- listRegistrations
- forms/repository.ts
- registrations/schemas.ts
- complete/route.ts
- communications/schemas.ts
- 20260722190000_foundation/migration.sql
- attendee-pass-qr-route.test.ts
- logError
- admin/page.tsx
- rate-limit-auth-routes.test.ts
- registration-lifecycle-route.test.ts
- mfa-service.test.ts
- editor-draft.ts
- resolve/route.ts
- request-context.ts
- reminder-messaging-repository.test.ts
- getPrisma
- announcements/route.ts
- square/route.ts
- app-shell.tsx
- outbox-sweep.ts
- program-assignments/route.ts
- client.ts
- package.json
- registration-operations-repository.test.ts
- [eventId]/attendee-passes/[attendeeId]/qr/route.ts
- account-email.ts
- getServerEnv
- promo-code-routes.test.ts
- [eventId]/registrations/route.ts
- next.config.ts
- 20260723010000_messaging_outbox/migration.sql
- lifecycle.ts
- definition.ts
- demo-data.ts
- square-webhook-route.test.ts
- 20260722213000_access_foundation/migration.sql
- 20260722230000_registration_builder/migration.sql
- 20260723020000_repeatable_attendee_rosters/migration.sql
- 20260723030000_registration_lifecycle_waitlist/migration.sql
- 20260723120000_registration_transfer_substitution/migration.sql
- 20260723121000_promoted_waitlist_payment_choice/migration.sql
- app/layout.tsx
- 20260722221500_staging_imports/migration.sql
- 20260723000000_public_registration/migration.sql
- 20260723060000_external_email_delivery/migration.sql
- 20260723070000_square_sandbox_payments/migration.sql
- 20260723102000_event_promo_codes/migration.sql
- "ProgramAssignmentRun"
- eslint.config.mjs
- postcss.config.mjs
- 20260723040000_event_setup/migration.sql
- 20260723050000_registration_access_tokens/migration.sql
- 20260723080000_rate_limit_buckets/migration.sql
- payment-choice-migration.test.ts
- people-workspace.tsx
- resend.ts
- public-access/domain.ts
- payment-choice/route.ts
- resend/route.ts
- reports/page.tsx
- env.ts
- external-email-delivery.test.ts
- passwords.ts
- badges/page.tsx
- IMSDA Events
- [membershipId]/route.ts
- public-square-payment.tsx
- What needs to be done (prioritized)
- Production readiness progress
- promo-codes/domain.ts
- useAccessibleDialog
- IMSDA Events build status and WR26 feature audit
- checkin/repository.ts
- shirt-sizes.ts
- serializeRegistrationAccess
- [eventSlug]/page.tsx
- Deploying with Docker (xCloud "Deploy Any App From Git" and similar)
- public-shirt-size-route.test.ts
- Production readiness review
- ADR 0002: Unified IMSDA operations platform
- README.md
- verify-public-registration-messaging.ts
- verify-public-registration-roster.ts
- operations-domain.ts
- reports/route.ts
- login/page.tsx
- P1 — Required before real attendee data, not necessarily before first login.
- Communications module
- Program assignments
- @prisma/client
- attendee-pass-route.test.ts
- ADR 0001: Foundation architecture
- Integration boundary
- Promo codes
- 20260724140000_admin_mfa/migration.sql
- Import scripts
- Check-in module
- 20260724000000_account_activation/migration.sql
- pg-restore-verify.sh
- AGENTS.md
- docker-entrypoint.sh
- forms/README.md
- operations/README.md
- people/README.md
- registrations/README.md
- 20260724120000_account_email_delivery/migration.sql
- 20260724160000_alert_notifications/migration.sql
- backup-scheduler.sh
- pg-backup.sh
- outbox-sweep.sh
- forgot-password/page.tsx
- secret-box.ts
- health/page.tsx
- promo-codes/schemas.ts
- more/page.tsx
- [runId]/page.tsx
- [token]/route.ts
- toCsv
- operational-health.test.ts
- operations/repository.ts
- public-registration-route.test.ts
- promo-code-workspace.tsx
- registration-builder/page.tsx
- "Organization"
- organizations/README.md

## God Nodes (most connected - your core abstractions)
1. `getPrisma()` - 162 edges
2. `logError()` - 129 edges
3. `getCurrentSession` - 115 edges
4. `rejectCrossOriginRequest()` - 110 edges
5. `findActiveMembership()` - 93 edges
6. `requirePermission()` - 87 edges
7. `withRequestContext()` - 70 edges
8. `AccessDeniedError` - 45 edges
9. `resolveEventContext()` - 40 edges
10. `hashOpaqueToken()` - 31 edges

## Surprising Connections (you probably didn't know these)
- `getHandler()` --indirect_call--> `findActiveMembership()`  [INFERRED]
  app/api/events/[eventId]/announcements/route.ts → modules/events/repository.ts
- `getHandler()` --indirect_call--> `findActiveMembership()`  [INFERRED]
  app/api/events/[eventId]/attendee-passes/[attendeeId]/qr/route.ts → modules/events/repository.ts
- `applyPrivateHeaders()` --indirect_call--> `value()`  [INFERRED]
  app/api/events/[eventId]/attendee-passes/resolve/route.ts → modules/payments/square-config.ts
- `postHandler()` --indirect_call--> `findActiveMembership()`  [INFERRED]
  app/api/events/[eventId]/attendee-passes/resolve/route.ts → modules/events/repository.ts
- `applyPrivateHeaders()` --indirect_call--> `value()`  [INFERRED]
  app/api/events/[eventId]/attendees/[attendeeId]/check-in/route.ts → modules/payments/square-config.ts

## Import Cycles
- None detected.

## Communities (189 total, 33 thin omitted)

### Community 0 - "checkin/domain.ts"
Cohesion: 0.12
Nodes (29): attendeeTypeLabel(), BarcodeDetectorConstructor, BarcodeDetectorInstance, cameraMessage(), CameraState, CheckInScanner(), DetectedBarcode, extractAttendeePassToken() (+21 more)

### Community 1 - "program-assignments/repository.ts"
Cohesion: 0.05
Nodes (61): ApiResult, AppliedRun, assignedRankLabel(), fieldIdentity(), localDate(), ProgramAssignmentsWorkspace(), addCost(), addFlowEdge() (+53 more)

### Community 2 - "payment-choice-repository.ts"
Cohesion: 0.13
Nodes (24): processingFeeForSubtotal(), PaymentChoiceInput, paymentChoiceInputSchema, paymentChoiceQuoteForSelection(), paymentChoiceRequestFingerprint(), PaymentChoiceResult, paymentChoiceResultSchema, paymentConfigurationFromDefinition() (+16 more)

### Community 3 - "operational-reports.ts"
Cohesion: 0.10
Nodes (37): activeStatusSet, addResponseFields(), addSeminarRanks(), addStructuredCount(), buildOperationalReport(), choiceFieldTypeSet, definitionFields(), ensureCountField() (+29 more)

### Community 4 - "email-delivery.ts"
Cohesion: 0.13
Nodes (23): getResendEmailConfiguration(), AccountEmailNotConfiguredError, ClaimedMessage, claimNextMessage(), DeliveryPrisma, EmailBodyPreparationInput, emailRetryDelayMs(), ExternalEmailDeliveryDependencies (+15 more)

### Community 5 - "request-security.ts"
Cohesion: 0.12
Nodes (15): apiError(), POST, apiError(), GET, getHandler(), PATCH, apiError(), POST (+7 more)

### Community 6 - "promo-codes/repository.ts"
Cohesion: 0.11
Nodes (26): metadata, PromoCodesPage(), normalizePromoCode(), PromoCodeFailureReason, promoCodeField(), ClaimedPromoCode, claimPromoCode(), createPromoCode() (+18 more)

### Community 7 - "registration-builder-workspace.tsx"
Cohesion: 0.08
Nodes (38): blankPreviewAttendees(), choicePresets, conditionLabels, defaultField(), DragState, fieldKey(), FieldModuleDefinition, fieldModules (+30 more)

### Community 8 - "events/repository.ts"
Cohesion: 0.17
Nodes (15): authorize(), eventApiError(), GET, getHandler(), PATCH, patchHandler(), POST, createEvent() (+7 more)

### Community 9 - "event-settings-workspace.tsx"
Cohesion: 0.09
Nodes (21): EventSetupPage(), metadata, draftFromEvent(), EventApiResult, EventSettingsWorkspace(), EventSettingsWorkspaceProps, timeZoneLabels, EventReadinessItem (+13 more)

### Community 10 - "attendee-pass-repository.ts"
Cohesion: 0.11
Nodes (31): activeStatusSet, attendeeName(), AttendeePassLookup, AttendeePassResolutionError, createAuthorizedAttendeePass(), createStaffAttendeePass(), jsonRecord(), resolveAttendeePassForEvent() (+23 more)

### Community 11 - "RegistrationFormDefinition"
Cohesion: 0.12
Nodes (6): RegistrationFormDefinition, PublicRegistrationInput, publicRegistrationInputSchema, definition, dependencies, input

### Community 12 - "forms/public-repository.ts"
Cohesion: 0.09
Nodes (37): EmbeddedRegistrationPage(), EmbeddedRegistrationPageProps, metadata, serializeDate(), generateMetadata(), PublicRegistrationPage(), PublicRegistrationPageProps, serializeDate() (+29 more)

### Community 13 - "public-registration-form.tsx"
Cohesion: 0.11
Nodes (25): addResponsesToUsage(), attendeeName(), cloneChoiceUsage(), Confirmation, controlId(), FieldRenderContext, formatEventDates(), formatManageLinkExpiry() (+17 more)

### Community 14 - "imports/repository.ts"
Cohesion: 0.07
Nodes (58): ImportsPage(), metadata, attendeeTypeSchema, createImportSnapshotIdentity(), CsvImportError, importColumns, normalizeDate(), NormalizedImportData (+50 more)

### Community 15 - "forms/public-domain.ts"
Cohesion: 0.24
Nodes (21): hasValue(), isFieldVisible(), validateTestResponses(), addResponsesToUsage(), cloneUsage(), extractName(), extractPublicAttendeeIdentity(), extractPublicContactIdentity() (+13 more)

### Community 16 - "getCurrentSession"
Cohesion: 0.11
Nodes (54): patchHandler(), postHandler(), authorize(), GET, getHandler(), POST, postHandler(), getHandler() (+46 more)

### Community 17 - "lifecycle-repository.ts"
Cohesion: 0.13
Nodes (34): activateOptionReservations(), auditTransition(), autoPromoteEarliestFitting(), cancelRegistration(), CancelRegistrationResult, CapacityCheck, checkEventCapacity(), checkOptionCapacity() (+26 more)

### Community 18 - "square-repository.ts"
Cohesion: 0.12
Nodes (29): internalPaymentState(), internalRefundStatus(), providerIdempotencyKey(), AppliedProviderPayment, applyPaymentWebhook(), applyProviderPayment(), applyRefundWebhook(), AttemptRecord (+21 more)

### Community 19 - "operations-repository.ts"
Cohesion: 0.15
Nodes (26): QueuedTransactionalMessage, activeManageTokenCount(), attendeeIdentity(), combineQueuedNotices(), contactIdentity(), iso(), jsonRecord(), loadOperationRegistration() (+18 more)

### Community 20 - "messaging-repository.ts"
Cohesion: 0.09
Nodes (43): asMessagingDeliveryError(), BalanceReminderBatchOperation, captureMessageIdsLocally(), captureOneMessageLocally(), ConfirmationResendOperation, createLocalTestMessage(), enqueueBalanceReminderBatch(), enqueuePublicRegistrationMessages() (+35 more)

### Community 21 - "templates.ts"
Cohesion: 0.12
Nodes (26): ALLOWED_MESSAGE_TEMPLATE_TOKENS, DEFAULT_MESSAGE_TEMPLATE_BODIES, DEFAULT_MESSAGE_TEMPLATE_DESCRIPTIONS, DEFAULT_MESSAGE_TEMPLATE_LIST, DEFAULT_MESSAGE_TEMPLATE_NAMES, DEFAULT_MESSAGE_TEMPLATE_SUBJECTS, extractMessageTemplateTokens(), formatMessageTemplateToken() (+18 more)

### Community 22 - "compilerOptions"
Cohesion: 0.07
Nodes (28): dom, dom.iterable, esnext, **/*.mts, .next/dev/types/**/*.ts, next-env.d.ts, .next/types/**/*.ts, node_modules (+20 more)

### Community 23 - "public-access/repository.ts"
Cohesion: 0.13
Nodes (20): createRegistrationAccessToken(), findStableExisting(), issuedAccess(), IssuedRegistrationAccessToken, issueRegistrationAccessToken(), IssueRegistrationAccessTokenInput, issueRegistrationAccessTokenValue(), issueStableRegistrationAccessToken() (+12 more)

### Community 24 - "access/authorization.ts"
Cohesion: 0.08
Nodes (31): actionSchema, apiError(), GET, getHandler(), POST, apiError(), DELETE, deleteHandler() (+23 more)

### Community 25 - "hashOpaqueToken"
Cohesion: 0.11
Nodes (30): AccountTokenIssue, authenticateWithPassword(), issueAccountToken(), issueAccountTokenForUser(), issuePasswordReset(), PasswordAuthentication, issueMfaChallenge(), spendPasswordCheck() (+22 more)

### Community 26 - "resolveEventContext"
Cohesion: 0.16
Nodes (17): WorkspaceLayout(), EventSettingsPage(), metadata, metadata, StaffPage(), AppShell(), StaffMembership, StaffWorkspace() (+9 more)

### Community 27 - "transactional-messages.ts"
Cohesion: 0.17
Nodes (21): formatMessageMoney(), attendeeName(), cancellationPaymentWording(), enqueueAttendeeSubstitutedMessage(), enqueuePaymentReceiptMessage(), enqueueRegistrationCancelledMessage(), enqueueRegistrationContactUpdatedMessage(), enqueueRegistrationTransferredNewContactMessage() (+13 more)

### Community 28 - "events/public-domain.ts"
Cohesion: 0.15
Nodes (21): sitemap(), buildPublicEventAnnouncementFeed(), calendarDateLabel(), describePublicEventLifecycle(), formatPublicEventSchedule(), isExactAllAttendeesAudience(), PublicAnnouncementCandidate, publicAnnouncementPlacementLabel() (+13 more)

### Community 29 - "reminder-audience.ts"
Cohesion: 0.24
Nodes (10): BalanceReminderCandidate, BalanceReminderPreviewContext, computeBalanceReminderPreview(), emailSchema, fingerprintPayload(), normalizedEmail(), skipReasonLabels, BalanceReminderPreview (+2 more)

### Community 30 - "devDependencies"
Cohesion: 0.08
Nodes (25): eslint, eslint-config-next, devDependencies, eslint, eslint-config-next, prisma, tailwindcss, @tailwindcss/postcss (+17 more)

### Community 31 - "check-in/route.ts"
Cohesion: 0.25
Nodes (12): apiError(), applyPrivateHeaders(), authorize(), DELETE, deleteHandler(), json(), POST, postHandler() (+4 more)

### Community 32 - "communications-workspace.tsx"
Cohesion: 0.08
Nodes (35): CommunicationsPage(), communicationViews, emptyMessaging, metadata, ApiResult, canResendConfirmation(), CommunicationsWorkspace(), CommunicationsWorkspaceProps (+27 more)

### Community 33 - "square-domain.ts"
Cohesion: 0.19
Nodes (13): moneyToCents(), record(), registrationBalanceCents(), selectedCardPayment(), SquareCheckoutState, SquareCheckoutView, squareMoneySchema, SquarePaymentInput (+5 more)

### Community 35 - "square-payment-repository.test.ts"
Cohesion: 0.12
Nodes (17): createSquarePayment(), CreateSquarePaymentInput, Fetcher, providerError(), record(), SquareAdapterError, SquarePaymentResult, SquarePaymentStatus (+9 more)

### Community 36 - "operational-health.ts"
Cohesion: 0.17
Nodes (19): activeRegistrationStatuses, ageMinutes(), atOrNearCapacity(), BalanceIssue, balanceIssues(), buildOperationalHealth(), CapacityIssue, capacityIssues() (+11 more)

### Community 37 - "[action]/route.ts"
Cohesion: 0.20
Nodes (12): errorResponse(), noStoreHeaders, postHandler(), errorResponse(), lifecycleActionSchema, noStoreHeaders, postHandler(), processMessagesAfterCommit() (+4 more)

### Community 38 - "service.ts"
Cohesion: 0.11
Nodes (38): bindingDecision(), getRateLimitConfiguration(), hashRateLimitIdentifier(), normalizeIpCandidate(), rateLimitClientIdentityHash(), RateLimitConfiguration, RateLimitConfigurationError, RateLimitDecision (+30 more)

### Community 39 - "registrations/repository.ts"
Cohesion: 0.11
Nodes (22): PaymentOperationError, recordManualPayment(), recordRefund(), addRegistrationAttendee(), createRegistration(), getRegistrationById(), getRegistrationByIdWithClient(), moneyToCents() (+14 more)

### Community 40 - "scripts"
Cohesion: 0.09
Nodes (22): scripts, admin:create, admin:reset-mfa, build, db:deploy, db:generate, db:migrate, db:refresh-demo (+14 more)

### Community 41 - "organizations/repository.ts"
Cohesion: 0.07
Nodes (50): PATCH, patchHandler(), POST, postHandler(), PATCH, patchHandler(), GET, getHandler() (+42 more)

### Community 42 - "registration-operation-routes.test.ts"
Cohesion: 0.17
Nodes (9): POST, POST, RegistrationOperationError, accessMocks, messageMocks, operationMocks, privateAccessMocks, responseSnapshot (+1 more)

### Community 43 - "payment/route.ts"
Cohesion: 0.16
Nodes (16): applyPrivateHeaders(), errorResponse(), GET, getHandler(), json(), operationErrorResponse(), POST, postHandler() (+8 more)

### Community 44 - "public-registration-access-route.test.ts"
Cohesion: 0.18
Nodes (8): GET, PATCH, context, messagingMocks, rateLimitMocks, registrationView, repositoryMocks, token

### Community 45 - "dependencies"
Cohesion: 0.13
Nodes (15): @fontsource/noto-sans, lucide-react, next, dependencies, @fontsource/noto-sans, lucide-react, next, react (+7 more)

### Community 46 - "registration-attendee-route.test.ts"
Cohesion: 0.40
Nodes (3): POST, context, mocks

### Community 47 - "message-retry-repository.test.ts"
Cohesion: 0.20
Nodes (11): MessageRetryFingerprintInput, messageRetryIdempotencyKey(), messageRetryRequestFingerprint(), serializeMessage(), messageRetryInputSchema, deliveryDependencies, fingerprintFor(), mocks (+3 more)

### Community 48 - "[token]/page.tsx"
Cohesion: 0.17
Nodes (13): expiryLabel(), metadata, money(), moneyFormatter, PublicManagePage(), PublicManagePageProps, submittedLabel(), PublicAttendeePasses() (+5 more)

### Community 50 - "listRegistrations"
Cohesion: 0.17
Nodes (15): CheckInPage(), metadata, eventDateLabel(), metadata, PrintableAttendeePassesPage(), FinancePage(), metadata, metadata (+7 more)

### Community 51 - "forms/repository.ts"
Cohesion: 0.23
Nodes (15): getFormTemplate(), createRegistrationForm(), createTestSubmission(), definitionFromJson(), FormWithVersions, getRegistrationForm(), loadForm(), publishRegistrationForm() (+7 more)

### Community 52 - "registrations/schemas.ts"
Cohesion: 0.16
Nodes (13): attendeeInputSchema, AttendeeSubstitutionInput, attendeeSubstitutionInputSchema, emailField, operationIdentityFields, registrationEditableFields, registrationFields, registrationInputSchema (+5 more)

### Community 53 - "complete/route.ts"
Cohesion: 0.24
Nodes (9): POST, postHandler(), resetSchema, metadata, ResetPasswordPage(), PasswordResetForm(), describeAccountToken(), resetPassword() (+1 more)

### Community 54 - "communications/schemas.ts"
Cohesion: 0.14
Nodes (13): BalanceReminderBatchInput, balanceReminderBatchInputSchema, ConfirmationResendInput, confirmationResendInputSchema, MessageRetryInput, MessageTemplateInput, messageTemplateInputSchema, MessageTestInput (+5 more)

### Community 55 - "20260722190000_foundation/migration.sql"
Cohesion: 0.34
Nodes (14): "Announcement", "AuditLog", "CheckIn", "Event", "EventMembership", "Household", "HouseholdMember", "ImportRun" (+6 more)

### Community 56 - "attendee-pass-qr-route.test.ts"
Cohesion: 0.40
Nodes (4): GET, context, mocks, token

### Community 57 - "logError"
Cohesion: 0.12
Nodes (30): loginSchema, postHandler(), challengeSchema, mfaErrorResponse(), POST, postHandler(), postHandler(), requestSchema (+22 more)

### Community 58 - "admin/page.tsx"
Cohesion: 0.15
Nodes (17): dateRange(), metadata, money(), phaseLabel(), platformModules, statusLabel(), SystemAdminPage(), activeRegistrationStatuses (+9 more)

### Community 59 - "rate-limit-auth-routes.test.ts"
Cohesion: 0.22
Nodes (6): POST, POST, accountEmailMocks, authMocks, mfaMocks, rateLimitMocks

### Community 61 - "mfa-service.test.ts"
Cohesion: 0.19
Nodes (17): RFC-4226, RFC-4648, decodeBase32(), encodeBase32(), generateTotpSecret(), otpauthUri(), totpCode(), totpCodeForStep() (+9 more)

### Community 62 - "editor-draft.ts"
Cohesion: 0.21
Nodes (15): currentPromoCodeEditorDraft(), emptyPromoCodeEditorDraft(), isPromoCodeEditorDraftDirty(), normalizedDate(), normalizedDiscountType(), NormalizedPromoCodeEditorDraft, normalizedScaledNumber(), normalizePromoCodeEditorDraft() (+7 more)

### Community 63 - "resolve/route.ts"
Cohesion: 0.39
Nodes (7): applyPrivateHeaders(), errorResponse(), json(), lookupSchema, postHandler(), privateHeaders, RouteContext

### Community 64 - "request-context.ts"
Cohesion: 0.06
Nodes (30): POST, postHandler(), POST, GET, GET, apiError(), GET, getHandler() (+22 more)

### Community 65 - "reminder-messaging-repository.test.ts"
Cohesion: 0.20
Nodes (9): MessagingError, DEFAULT_MESSAGE_TEMPLATES, baseTransaction(), confirmationFixture(), ConfirmationMessage, event, mocks, money() (+1 more)

### Community 66 - "getPrisma"
Cohesion: 0.12
Nodes (36): postHandler(), getPrisma(), globalForPrisma, addStaffMembership(), listStaffMemberships(), setGlobalRole(), StaffMembershipRecord, updateStaffMembership() (+28 more)

### Community 67 - "announcements/route.ts"
Cohesion: 0.24
Nodes (8): PATCH, announcementSchema, apiError(), GET, getHandler(), POST, createAnnouncement(), publishAnnouncement()

### Community 68 - "square/route.ts"
Cohesion: 0.16
Nodes (18): json(), noStoreHeaders, postHandler(), exactApiUrl(), getSquareConfiguration(), publicSquareConfiguration(), SquareConfigurationIssue, SquareEnvironment (+10 more)

### Community 69 - "app-shell.tsx"
Cohesion: 0.24
Nodes (7): metadata, NoAccessPage(), navigation, NavigationItem, ShellEvent, ShellUser, SignOutButton()

### Community 70 - "outbox-sweep.ts"
Cohesion: 0.12
Nodes (23): POST, postHandler(), processPendingMessages(), assessOutboxQueue(), getOutboxQueueHealth(), getOutboxQueueSnapshot(), isAuthorizedSweepRequest(), OutboxQueueHealth (+15 more)

### Community 71 - "program-assignments/route.ts"
Cohesion: 0.20
Nodes (12): GET, getHandler(), POST, postHandler(), programAssignmentApiError(), GET, getHandler(), requireProgramAssignmentAccess() (+4 more)

### Community 72 - "client.ts"
Cohesion: 0.25
Nodes (7): createSquarePayment(), getSquareConfiguration(), SQUARE_HOSTS, SquareConfigurationError, SquareEnvironment, SquarePaymentInput, SquarePaymentResult

### Community 73 - "package.json"
Cohesion: 0.22
Nodes (8): engines, node, name, overrides, postcss, sharp, private, version

### Community 74 - "registration-operations-repository.test.ts"
Cohesion: 0.25
Nodes (8): actor, baseRegistration(), fixture(), messageMocks, now, prismaMocks, registrationMocks, transferInput

### Community 75 - "[eventId]/attendee-passes/[attendeeId]/qr/route.ts"
Cohesion: 0.22
Nodes (9): GET, getHandler(), privateHeaders, privateJson(), RouteContext, qrcode, qrcode, context (+1 more)

### Community 76 - "account-email.ts"
Cohesion: 0.14
Nodes (20): logInfo(), revokeAccountToken(), accountEmailContent(), AccountEmailPurpose, AccountEmailSender, describeLifetime(), AccountEmailDispatch, dispatch() (+12 more)

### Community 77 - "getServerEnv"
Cohesion: 0.11
Nodes (24): GET, getHandler(), getServerEnv(), logWarn(), currentCorrelationId(), BreachCheckResult, checkPasswordAgainstBreachCorpus(), isBreachCheckEnabled() (+16 more)

### Community 78 - "promo-code-routes.test.ts"
Cohesion: 0.18
Nodes (11): PATCH, GET, POST, POST, dependencies, promoInput, publicContext, quoteRequest() (+3 more)

### Community 79 - "[eventId]/registrations/route.ts"
Cohesion: 0.48
Nodes (6): apiError(), authorize(), GET, getHandler(), POST, postHandler()

### Community 80 - "next.config.ts"
Cohesion: 0.33
Nodes (4): nextConfig, privateRegistrationHeaders, sharedSecurityHeaders, squareFontOrigins

### Community 81 - "20260723010000_messaging_outbox/migration.sql"
Cohesion: 0.60
Nodes (5): "EventMessageSettings", "EventMessageTemplate", "MessageDeliveryAttempt", "MessageOutbox", "MessageTemplateVersion"

### Community 82 - "lifecycle.ts"
Cohesion: 0.14
Nodes (20): formatEventDates(), metadata, money(), OverviewPage(), registrationSummary(), ActiveRegistrationStatus, calendarDateInEventTimeZone(), CapacityDecision (+12 more)

### Community 83 - "definition.ts"
Cohesion: 0.06
Nodes (34): attendeeNameKeys, AttendeeRosterConfig, availabilityModes, calendarDateSchema, campMeetingHousingOptions, campMeetingNights, choiceFieldTypes, createFormSchema (+26 more)

### Community 84 - "demo-data.ts"
Cohesion: 0.40
Nodes (4): demoAnnouncements, demoEvent, demoMetrics, demoPeople

### Community 85 - "square-webhook-route.test.ts"
Cohesion: 0.40
Nodes (5): POST, mocks, rawBody, request(), signature()

### Community 86 - "20260722213000_access_foundation/migration.sql"
Cohesion: 0.50
Nodes (3): "AuthCredential", "PasswordResetToken", "UserSession"

### Community 87 - "20260722230000_registration_builder/migration.sql"
Cohesion: 0.83
Nodes (3): "FormTestSubmission", "RegistrationForm", "RegistrationFormVersion"

### Community 88 - "20260723020000_repeatable_attendee_rosters/migration.sql"
Cohesion: 0.67
Nodes (3): "PublicRegistrationSubmission", "RegistrationAttendee", "RegistrationCapacityReservation"

### Community 89 - "20260723030000_registration_lifecycle_waitlist/migration.sql"
Cohesion: 0.83
Nodes (3): "Event", "Registration", "RegistrationWaitlistEntry"

### Community 90 - "20260723120000_registration_transfer_substitution/migration.sql"
Cohesion: 0.67
Nodes (3): "RegistrationOperation", "RegistrationOperation_immutable", "reject_registration_operation_mutation"()

### Community 91 - "20260723121000_promoted_waitlist_payment_choice/migration.sql"
Cohesion: 0.67
Nodes (3): "RegistrationPaymentChoiceOperation", "RegistrationPaymentChoiceOperation_immutable", "reject_registration_payment_choice_operation_mutation"()

### Community 117 - "people-workspace.tsx"
Cohesion: 0.26
Nodes (12): answerLabel(), answerValue(), fieldLabelsFromDefinition(), initials(), LifecycleAction, lifecycleCopy, money(), PeopleWorkspace() (+4 more)

### Community 118 - "resend.ts"
Cohesion: 0.19
Nodes (9): cleanHeaderText(), EmailDeliveryInput, EmailDeliveryResult, EmailProviderConfigurationError, EmailProviderRequestError, getResendEmailAvailability(), ResendEmailConfiguration, sendEmailWithResend() (+1 more)

### Community 119 - "public-access/domain.ts"
Cohesion: 0.22
Nodes (14): cents(), defaultRegistrationAccessExpiry(), describePublicRegistrationStatus(), jsonRecord(), nonEmptyString(), publicAttendeeName(), publicContactFromSnapshot(), PublicContactUpdateInput (+6 more)

### Community 120 - "payment-choice/route.ts"
Cohesion: 0.15
Nodes (14): applyPrivateHeaders(), errorResponse(), json(), operationErrorResponse(), POST, postHandler(), privateHeaders, RouteContext (+6 more)

### Community 121 - "resend/route.ts"
Cohesion: 0.15
Nodes (15): POST, postHandler(), ResendWebhookConfigurationError, ResendWebhookEvent, resendWebhookEventSchema, ResendWebhookVerificationError, verifyResendWebhook(), finalizeSuccessfulAttempt() (+7 more)

### Community 122 - "reports/page.tsx"
Cohesion: 0.24
Nodes (11): CountFields(), displayCount(), metadata, OperationalReportsPage(), reportDownloadHref(), scopeLabel(), SeminarFields(), OperationalCountField (+3 more)

### Community 123 - "env.ts"
Cohesion: 0.17
Nodes (12): onRequestError(), register(), assertServerEnvAtStartup(), optionalTrimmed, readSource(), ServerEnv, ServerEnvironmentError, serverEnvSchema (+4 more)

### Community 124 - "external-email-delivery.test.ts"
Cohesion: 0.22
Nodes (7): resetServerEnvCache(), accountStore(), configureAccountEmail(), dependencies, fakeDeliveryStore(), MutableMessage, originalEnv

### Community 125 - "passwords.ts"
Cohesion: 0.18
Nodes (19): COMMON_PASSWORD_BASES, LEET_SUBSTITUTIONS, applyLeetSubstitutions(), characterCount(), hasControlCharacters(), isSequential(), normalize(), passwordCandidates() (+11 more)

### Community 126 - "badges/page.tsx"
Cohesion: 0.33
Nodes (11): metadata, PrintableNameBadgesPage(), BadgeLabel, BadgeTemplateId, badgeTemplateIds, badgeTemplates, buildBadgeLabels(), normalizeBadgeStartingPosition() (+3 more)

### Community 127 - "IMSDA Events"
Cohesion: 0.14
Nodes (14): Account email, Architecture, Build status and next review gate, Current API, Database commands, Design direction, IMSDA Events, Local setup (+6 more)

### Community 128 - "[membershipId]/route.ts"
Cohesion: 0.18
Nodes (9): PATCH, updateSchema, apiError(), globalRoleSchema, PATCH, patchHandler(), MembershipOperationError, mocks (+1 more)

### Community 129 - "public-square-payment.tsx"
Cohesion: 0.17
Nodes (13): fetchCheckout(), money(), payments(), PublicSquarePayment(), SquareCard, SquareCheckout, SquarePayments, unavailableCheckout() (+5 more)

### Community 130 - "What needs to be done (prioritized)"
Cohesion: 0.15
Nodes (12): 1. Complete the Phase 2 data model (plan §4.2, §4.4), 2. Communications expansion (Phase 6, plan §4.7), 3. Attendee application (Phase 7, plan §4.8), 4. External integrations (Phase 8, plan §4.9), 5. Hardening & cutover (Phase 9, plan §5.4–5.7), 6. Event-day release gate (near-term, already flagged in BUILD-STATUS), 7. Optional: WR26 live source adapter (Phase 3, backlog #6), Build-plan gap analysis (+4 more)

### Community 131 - "Production readiness progress"
Cohesion: 0.15
Nodes (13): 10. Printable passes and rosters — not started, 1. Admin bootstrap — done, 2. Account lifecycle — done, 3. Startup environment contract — done, 4. Backups and verified restore — done, one decision outstanding, 5. Structured logging and alerting — done, 6. Outbox sweep and health readiness — done, 7. MFA, password policy, session hardening — done (+5 more)

### Community 132 - "promo-codes/domain.ts"
Cohesion: 0.21
Nodes (11): FormCalculation, applyPromoCodeToCalculation(), DiscountedFormCalculation, evaluatePromoCode(), isNormalizedPromoCode(), money(), processingFeeForDiscountedSubtotal(), PromoCodeEvaluation (+3 more)

### Community 133 - "useAccessibleDialog"
Cohesion: 0.16
Nodes (17): activeFinancialStatuses, FinanceWorkspace(), money(), PaymentRecord, actionTone(), differenceLabel(), differenceValue(), ImportDifference (+9 more)

### Community 134 - "IMSDA Events build status and WR26 feature audit"
Cohesion: 0.17
Nodes (12): Behaviors not to copy from WR26, Capacity and event programs, Confirmation emails and notifications, Event-day operations, Important scope boundaries, IMSDA Events build status and WR26 feature audit, Payments, Recommended build order (+4 more)

### Community 135 - "checkin/repository.ts"
Cohesion: 0.25
Nodes (8): activeRegistrationStatusSet, checkInAttendee(), CheckInOperationDisposition, CheckInOperationError, retryableTransactionError(), checkInRecord(), dependencies, fixture()

### Community 136 - "shirt-sizes.ts"
Cohesion: 0.20
Nodes (13): confirmationLabel(), PublicShirtSizeConfirmation(), PublicShirtSizeConfirmationProps, SaveState, ShirtSizeAttendee, attendeeShirtSizeSchema, publicShirtSizeConfirmationSchema, record() (+5 more)

### Community 137 - "serializeRegistrationAccess"
Cohesion: 0.21
Nodes (12): isRegistrationAccessToken(), confirmPublicRegistrationShirtSizes(), confirmRegistrationShirtSizesWithClient(), eventUsesConventionShirts(), jsonRecord(), loadActiveAccessRecord(), moneyToCents(), resolveRegistrationAccessToken() (+4 more)

### Community 138 - "[eventSlug]/page.tsx"
Cohesion: 0.22
Nodes (8): generateMetadata(), PublicEventPage(), PublicEventPageProps, getPublicEventLanding, landing, landingMocks, now, prismaMocks

### Community 139 - "Deploying with Docker (xCloud "Deploy Any App From Git" and similar)"
Cohesion: 0.18
Nodes (11): Alerting, Backups and restore rehearsals, Default local development is unchanged, `dependency failed to start: container ...-app-1 is unhealthy`, Deploying with Docker (xCloud "Deploy Any App From Git" and similar), Environment variables (set these in the xCloud env panel), `error: OUTBOX_SWEEP_TOKEN: set this to at least 32 random characters ...`, First-deploy checklist (+3 more)

### Community 140 - "public-shirt-size-route.test.ts"
Cohesion: 0.25
Nodes (5): PATCH, body, context, mocks, token

### Community 141 - "Production readiness review"
Cohesion: 0.20
Nodes (10): 1. There is no path from a fresh deploy to a real administrator account, 2. A single bad environment variable silently 403s every write in the system, 3. No backups, and no evidence a restore works, P0 — Blocking. The system cannot be stood up for real as it is., P2 — Correctness and hygiene issues found during review., Production readiness review, Recommended sequence, Review of the build plan itself (+2 more)

### Community 142 - "ADR 0002: Unified IMSDA operations platform"
Cohesion: 0.29
Nodes (6): ADR 0002: Unified IMSDA operations platform, Consequences, Decision, Delivery order, Event billing, Medical and emergency operations

### Community 143 - "README.md"
Cohesion: 0.31
Nodes (3): Payments module, Sandbox setup, Square safety boundary

### Community 144 - "verify-public-registration-messaging.ts"
Cohesion: 0.27
Nodes (11): assert(), cleanup(), confirmationCodeFrom(), definition, internalEmails, JsonRecord, loadMessages(), main() (+3 more)

### Community 145 - "verify-public-registration-roster.ts"
Cohesion: 0.24
Nodes (11): asRecord(), assert(), attendeeNames, cleanup(), definition, firstRequestBody, JsonRecord, main() (+3 more)

### Community 146 - "operations-domain.ts"
Cohesion: 0.52
Nodes (5): canonicalValue(), identitiesDescribeSamePerson(), normalized(), OperationIdentity, registrationOperationFingerprint()

### Community 147 - "reports/route.ts"
Cohesion: 0.38
Nodes (5): GET, getHandler(), isOperationalReportKind(), dependencies, report

### Community 148 - "login/page.tsx"
Cohesion: 0.40
Nodes (4): LoginPage(), metadata, LoginForm(), MfaStep

### Community 149 - "P1 — Required before real attendee data, not necessarily before first login."
Cohesion: 0.33
Nodes (6): 1. Environment validation is partial and lazy, 2. Email retries are stranded without a sweeper, 3. No error monitoring, and logs are unstructured, 4. Medical, dietary, and screening answers are stored in plaintext JSON, 5. Session model has no idle timeout and no user-facing revocation, P1 — Required before real attendee data, not necessarily before first login.

### Community 150 - "Communications module"
Cohesion: 0.33
Nodes (5): Balance-reminder workflow, Communications module, Confirmation-copy workflow, Current boundary, Registration message behavior

### Community 151 - "Program assignments"
Cohesion: 0.33
Nodes (5): Deterministic assignment, Exact-source safety, Intentional boundaries, Program assignments, Staff workflow

### Community 152 - "@prisma/client"
Cohesion: 0.53
Nodes (5): @prisma/client, @prisma/client, main(), parseEmail(), usage()

### Community 153 - "attendee-pass-route.test.ts"
Cohesion: 0.40
Nodes (3): POST, context, mocks

### Community 154 - "ADR 0001: Foundation architecture"
Cohesion: 0.40
Nodes (4): ADR 0001: Foundation architecture, Consequences, Context, Decision

### Community 155 - "Integration boundary"
Cohesion: 0.50
Nodes (3): Integration boundary, Resend, Square

### Community 156 - "Promo codes"
Cohesion: 0.50
Nodes (3): Promo codes, Quote, claim, and history, Rules

### Community 157 - "20260724140000_admin_mfa/migration.sql"
Cohesion: 0.67
Nodes (3): "MfaChallenge", "MfaRecoveryCode", "UserMfaEnrollment"

### Community 158 - "Import scripts"
Cohesion: 0.50
Nodes (3): CSV contract, Import scripts, Matching and safety

### Community 174 - "forgot-password/page.tsx"
Cohesion: 0.50
Nodes (3): ForgotPasswordPage(), metadata, PasswordResetRequestForm()

### Community 175 - "secret-box.ts"
Cohesion: 0.33
Nodes (7): derivedKey(), isSecretEncryptionConfigured(), openSecret(), sealSecret(), SecretBoxError, prismaFixture(), dependencies

### Community 176 - "health/page.tsx"
Cohesion: 0.24
Nodes (10): hiddenRowsNotice(), metadata, money(), OperationalHealthPage(), SeverityBadge(), severityLabel(), timeLabel(), words() (+2 more)

### Community 177 - "promo-codes/schemas.ts"
Cohesion: 0.18
Nodes (10): calendarDateSchema, optionalDateSchema, PromoCodeInput, promoCodeInputSchema, promoCodeShape, PublicPromoCodeQuoteInput, publicPromoCodeQuoteInputSchema, quoteAttendeeSchema (+2 more)

### Community 178 - "more/page.tsx"
Cohesion: 0.27
Nodes (8): metadata, MorePage(), MfaManager(), MfaStatus, SessionManager(), SignedInSession, when(), listRecentAuditActivity()

### Community 179 - "[runId]/page.tsx"
Cohesion: 0.27
Nodes (8): metadata, ProgramAssignmentsPage(), metadata, ProgramAssignmentRosterPage(), rankLabel(), PrintReportButton(), canManageProgramAssignments(), getProgramAssignmentWorkspace()

### Community 180 - "[token]/route.ts"
Cohesion: 0.42
Nodes (9): applyPrivateHeaders(), errorResponse(), getHandler(), json(), patchHandler(), privateHeaders, RouteContext, unavailableResponse() (+1 more)

### Community 182 - "operational-health.test.ts"
Cohesion: 0.22
Nodes (5): EventPermission, OperationalHealthAccess, OperationalHealthSource, fullAccess, now

### Community 183 - "operations/repository.ts"
Cohesion: 0.33
Nodes (8): emptySource, getOperationalHealth(), loadCapacitySource(), loadFinanceSource(), loadImportSource(), loadMessageSource(), moneyToCents(), mocks

### Community 184 - "public-registration-route.test.ts"
Cohesion: 0.22
Nodes (6): GET, POST, context, rateLimitMocks, repositoryMocks, submission

### Community 185 - "promo-code-workspace.tsx"
Cohesion: 0.44
Nodes (7): availabilityLabel(), discountLabel(), money(), optionalIntegerValue(), optionalMoneyValue(), PromoCodeWorkspace(), useUnsavedChangesGuard()

### Community 186 - "registration-builder/page.tsx"
Cohesion: 0.60
Nodes (4): metadata, RegistrationBuilderPage(), listFormTemplates(), listRegistrationForms()

## Knowledge Gaps
- **813 isolated node(s):** `EmbeddedRegistrationPageProps`, `metadata`, `PublicEventPageProps`, `metadata`, `PublicManagePageProps` (+808 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **33 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getPrisma()` connect `getPrisma` to `program-assignments/repository.ts`, `payment-choice-repository.ts`, `email-delivery.ts`, `promo-codes/repository.ts`, `checkin/repository.ts`, `events/repository.ts`, `serializeRegistrationAccess`, `attendee-pass-repository.ts`, `forms/public-repository.ts`, `imports/repository.ts`, `getCurrentSession`, `lifecycle-repository.ts`, `square-repository.ts`, `operations-repository.ts`, `messaging-repository.ts`, `public-access/repository.ts`, `access/authorization.ts`, `hashOpaqueToken`, `resolveEventContext`, `events/public-domain.ts`, `check-in/route.ts`, `communications-workspace.tsx`, `[action]/route.ts`, `service.ts`, `registrations/repository.ts`, `organizations/repository.ts`, `payment/route.ts`, `more/page.tsx`, `forms/repository.ts`, `[runId]/page.tsx`, `complete/route.ts`, `[token]/route.ts`, `operations/repository.ts`, `listRegistrations`, `logError`, `registration-builder/page.tsx`, `admin/page.tsx`, `announcements/route.ts`, `outbox-sweep.ts`, `account-email.ts`, `getServerEnv`, `lifecycle.ts`, `resend/route.ts`?**
  _High betweenness centrality (0.173) - this node is a cross-community bridge._
- **Why does `logError()` connect `logError` to `[membershipId]/route.ts`, `email-delivery.ts`, `request-security.ts`, `events/repository.ts`, `forms/public-repository.ts`, `getCurrentSession`, `square-repository.ts`, `reports/route.ts`, `access/authorization.ts`, `check-in/route.ts`, `[action]/route.ts`, `service.ts`, `organizations/repository.ts`, `payment/route.ts`, `[token]/route.ts`, `complete/route.ts`, `resolve/route.ts`, `request-context.ts`, `announcements/route.ts`, `square/route.ts`, `outbox-sweep.ts`, `program-assignments/route.ts`, `[eventId]/attendee-passes/[attendeeId]/qr/route.ts`, `account-email.ts`, `getServerEnv`, `[eventId]/registrations/route.ts`, `payment-choice/route.ts`, `resend/route.ts`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **Why does `rejectCrossOriginRequest()` connect `getCurrentSession` to `[membershipId]/route.ts`, `request-security.ts`, `events/repository.ts`, `access/authorization.ts`, `check-in/route.ts`, `[action]/route.ts`, `organizations/repository.ts`, `payment/route.ts`, `[token]/route.ts`, `complete/route.ts`, `logError`, `resolve/route.ts`, `request-context.ts`, `getPrisma`, `announcements/route.ts`, `program-assignments/route.ts`, `[eventId]/registrations/route.ts`, `payment-choice/route.ts`, `external-email-delivery.test.ts`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **Are the 48 inferred relationships involving `findActiveMembership()` (e.g. with `patchHandler()` and `getHandler()`) actually correct?**
  _`findActiveMembership()` has 48 INFERRED edges - model-reasoned connections that need verification._
- **What connects `EmbeddedRegistrationPageProps`, `metadata`, `PublicEventPageProps` to the rest of the system?**
  _813 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `checkin/domain.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11932773109243698 - nodes in this community are weakly interconnected._
- **Should `program-assignments/repository.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05217391304347826 - nodes in this community are weakly interconnected._