# Graph Report - IMSDA Events  (2026-07-27)

## Corpus Check
- 435 files · ~241,822 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2857 nodes · 7138 edges · 195 communities (163 shown, 32 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 173 edges (avg confidence: 0.62)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `04a45512`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- checkin/domain.ts
- program-assignments/repository.ts
- payment-choice-repository.ts
- operational-reports.ts
- email-delivery.ts
- forms/route.ts
- promo-codes/repository.ts
- registration-builder-workspace.tsx
- events/repository.ts
- event-settings-workspace.tsx
- attendee-pass-repository.ts
- registrationFormDefinitionSchema
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
- rejectCrossOriginRequest
- hashOpaqueToken
- selection.ts
- transactional-messages.ts
- events/public-domain.ts
- types.ts
- devDependencies
- check-in/route.ts
- communications-workspace.tsx
- square-domain.ts
- getPrisma
- square-config.ts
- operational-health.ts
- logError
- service.ts
- registrations/repository.ts
- scripts
- organizations/repository.ts
- amendments-repository.ts
- payment/route.ts
- [token]/route.ts
- dependencies
- registration-attendee-route.test.ts
- retryMessage
- [token]/page.tsx
- brand-mark.tsx
- resolveEventContext
- forms/repository.ts
- registrations/schemas.ts
- auth-service.ts
- wr26-bundle.ts
- 20260722190000_foundation/migration.sql
- [registrationId]/route.ts
- applyRateLimitHeaders
- dashboard.ts
- login/route.ts
- registration-lifecycle-route.test.ts
- totp.ts
- editor-draft.ts
- resolve/route.ts
- request-context.ts
- reminder-messaging-repository.test.ts
- mfa-service.ts
- announcements/route.ts
- outbox-sweep.ts
- app-shell.tsx
- prisma.ts
- access/authorization.ts
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
- csv-parser.ts
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
- rate-limit/domain.ts
- env.ts
- rate-limit/repository.ts
- password-policy.ts
- badges/page.tsx
- IMSDA Events
- global-role/route.ts
- public-square-payment.tsx
- What needs to be done (prioritized)
- Production readiness progress
- promo-codes/domain.ts
- import-workspace.tsx
- IMSDA Events build status and WR26 feature audit
- checkin/repository.ts
- shirt-sizes.ts
- serializeRegistrationAccess
- [eventSlug]/page.tsx
- Deploying with Docker (xCloud "Deploy Any App From Git" and similar)
- shirt-sizes/route.ts
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
- registration-amendment-editor.tsx
- challenge/route.ts
- normalizePromoCode
- promo-codes/schemas.ts
- more/page.tsx
- passes/page.tsx
- events/schemas.ts
- square-payment-repository.test.ts
- admin/page.tsx
- logger.test.ts
- [formSlug]/registrations/route.ts
- promo-code-workspace.tsx
- getEventPublishReadiness
- "Organization"
- organizations/README.md
- registration-amendment-route.test.ts
- overview/page.tsx
- verify-public-registration-capacity.ts
- reset-password/page.tsx
- listPublicEventSitemapEntries

## God Nodes (most connected - your core abstractions)
1. `getPrisma()` - 139 edges
2. `logError()` - 127 edges
3. `getCurrentSession` - 112 edges
4. `rejectCrossOriginRequest()` - 104 edges
5. `findActiveMembership()` - 93 edges
6. `requirePermission()` - 87 edges
7. `withRequestContext()` - 71 edges
8. `AccessDeniedError` - 46 edges
9. `resolveEventContext()` - 39 edges
10. `getServerEnv()` - 28 edges

## Surprising Connections (you probably didn't know these)
- `prismaFixture()` --indirect_call--> `value()`  [INFERRED]
  tests/outbox-sweep.test.ts → modules/payments/square-config.ts
- `ImportWorkspace()` --indirect_call--> `record()`  [INFERRED]
  components/import-workspace.tsx → modules/registrations/shirt-sizes.ts
- `cloneChoiceUsage()` --calls--> `getAvailabilityMode()`  [EXTRACTED]
  components/public-registration-form.tsx → modules/forms/definition.ts
- `calculateRosterTotal()` --indirect_call--> `label()`  [INFERRED]
  modules/forms/definition.ts → tests/badge-labels.test.ts
- `differencesFor()` --indirect_call--> `source()`  [INFERRED]
  modules/imports/repository.ts → tests/system-admin-dashboard.test.ts

## Import Cycles
- None detected.

## Communities (195 total, 32 thin omitted)

### Community 0 - "checkin/domain.ts"
Cohesion: 0.12
Nodes (28): attendeeTypeLabel(), BarcodeDetectorConstructor, BarcodeDetectorInstance, cameraMessage(), CameraState, CheckInScanner(), DetectedBarcode, extractAttendeePassToken() (+20 more)

### Community 1 - "program-assignments/repository.ts"
Cohesion: 0.05
Nodes (60): ApiResult, AppliedRun, assignedRankLabel(), fieldIdentity(), localDate(), ProgramAssignmentsWorkspace(), addCost(), addFlowEdge() (+52 more)

### Community 2 - "payment-choice-repository.ts"
Cohesion: 0.12
Nodes (25): processingFeeForSubtotal(), PaymentChoiceInput, paymentChoiceInputSchema, paymentChoiceQuoteForSelection(), paymentChoiceRequestFingerprint(), PaymentChoiceResult, paymentChoiceResultSchema, paymentConfigurationFromDefinition() (+17 more)

### Community 3 - "operational-reports.ts"
Cohesion: 0.07
Nodes (52): CountFields(), displayCount(), metadata, OperationalReportsPage(), reportDownloadHref(), scopeLabel(), SeminarFields(), CheckInWorkspace() (+44 more)

### Community 4 - "email-delivery.ts"
Cohesion: 0.13
Nodes (23): getResendEmailConfiguration(), AccountEmailNotConfiguredError, ClaimedMessage, claimNextMessage(), DeliveryPrisma, EmailBodyPreparationInput, emailRetryDelayMs(), ExternalEmailDeliveryDependencies (+15 more)

### Community 5 - "forms/route.ts"
Cohesion: 0.19
Nodes (11): apiError(), GET, getHandler(), PATCH, patchHandler(), apiError(), GET, getHandler() (+3 more)

### Community 6 - "promo-codes/repository.ts"
Cohesion: 0.15
Nodes (17): PromoCodeFailureReason, promoCodeField(), ClaimedPromoCode, claimPromoCode(), findPromoForCode(), getPublicPromoCodeQuote(), PromoClient, PromoCodeOperationError (+9 more)

### Community 7 - "registration-builder-workspace.tsx"
Cohesion: 0.10
Nodes (29): blankPreviewAttendees(), choicePresets, conditionLabels, defaultField(), DragState, fieldKey(), FieldModuleDefinition, fieldModules (+21 more)

### Community 8 - "events/repository.ts"
Cohesion: 0.11
Nodes (27): apiError(), DELETE, deleteHandler(), GET, getHandler(), authorize(), eventApiError(), GET (+19 more)

### Community 9 - "event-settings-workspace.tsx"
Cohesion: 0.20
Nodes (9): EventSetupPage(), metadata, draftFromEvent(), EventApiResult, EventSettingsWorkspace(), EventSettingsWorkspaceProps, timeZoneLabels, EventSettingsRecord (+1 more)

### Community 10 - "attendee-pass-repository.ts"
Cohesion: 0.11
Nodes (31): activeStatusSet, attendeeName(), AttendeePassLookup, AttendeePassResolutionError, createAuthorizedAttendeePass(), createStaffAttendeePass(), jsonRecord(), resolveAttendeePassForEvent() (+23 more)

### Community 11 - "registrationFormDefinitionSchema"
Cohesion: 0.07
Nodes (24): attendeeFields(), AttendeeRosterCsvError, AttendeeRosterCsvResponses, AttendeeRosterCsvValue, canonicalChoice(), convertValue(), createAttendeeRosterCsvTemplate(), escapeCsvCell() (+16 more)

### Community 12 - "forms/public-repository.ts"
Cohesion: 0.09
Nodes (33): EmbeddedRegistrationPage(), EmbeddedRegistrationPageProps, metadata, serializeDate(), generateMetadata(), PublicRegistrationPage(), PublicRegistrationPageProps, serializeDate() (+25 more)

### Community 13 - "public-registration-form.tsx"
Cohesion: 0.12
Nodes (23): attendeeName(), cloneChoiceUsage(), Confirmation, controlId(), FieldRenderContext, formatEventDates(), formatManageLinkExpiry(), formatPricingDate() (+15 more)

### Community 14 - "imports/repository.ts"
Cohesion: 0.15
Nodes (25): postHandler(), ImportsPage(), metadata, commitImportRun(), DatabaseClient, differencesFor(), getEventTotals(), getImportReconciliation() (+17 more)

### Community 15 - "forms/public-domain.ts"
Cohesion: 0.17
Nodes (29): addResponsesToUsage(), calculateFormTotal(), getAvailabilityMode(), hasValue(), isChoiceFieldType(), isFieldVisible(), pricedLineItem(), validateTestResponses() (+21 more)

### Community 16 - "getCurrentSession"
Cohesion: 0.11
Nodes (40): authorize(), GET, getHandler(), POST, postHandler(), GET, getHandler(), POST (+32 more)

### Community 17 - "lifecycle-repository.ts"
Cohesion: 0.12
Nodes (36): activateOptionReservations(), auditTransition(), autoPromoteEarliestFitting(), cancelRegistration(), CancelRegistrationResult, CapacityCheck, checkEventCapacity(), checkOptionCapacity() (+28 more)

### Community 18 - "square-repository.ts"
Cohesion: 0.12
Nodes (34): internalPaymentState(), internalRefundStatus(), moneyToCents(), providerIdempotencyKey(), registrationBalanceCents(), AppliedProviderPayment, applyPaymentWebhook(), applyProviderPayment() (+26 more)

### Community 19 - "operations-repository.ts"
Cohesion: 0.18
Nodes (23): QueuedTransactionalMessage, activeManageTokenCount(), attendeeIdentity(), combineQueuedNotices(), contactIdentity(), iso(), jsonRecord(), loadOperationRegistration() (+15 more)

### Community 20 - "messaging-repository.ts"
Cohesion: 0.07
Nodes (51): getResendEmailAvailability(), BalanceReminderBatchOperation, captureMessageIdsLocally(), captureOneMessageLocally(), ConfirmationResendOperation, createLocalTestMessage(), enqueueBalanceReminderBatch(), enqueuePublicRegistrationMessages() (+43 more)

### Community 21 - "templates.ts"
Cohesion: 0.12
Nodes (27): ALLOWED_MESSAGE_TEMPLATE_TOKENS, DEFAULT_MESSAGE_TEMPLATE_BODIES, DEFAULT_MESSAGE_TEMPLATE_DESCRIPTIONS, DEFAULT_MESSAGE_TEMPLATE_LIST, DEFAULT_MESSAGE_TEMPLATE_NAMES, DEFAULT_MESSAGE_TEMPLATE_SUBJECTS, extractMessageTemplateTokens(), formatMessageDateRange() (+19 more)

### Community 22 - "compilerOptions"
Cohesion: 0.07
Nodes (28): dom, dom.iterable, esnext, **/*.mts, .next/dev/types/**/*.ts, next-env.d.ts, .next/types/**/*.ts, node_modules (+20 more)

### Community 23 - "public-access/repository.ts"
Cohesion: 0.14
Nodes (19): PublicContactUpdateInput, createRegistrationAccessToken(), findStableExisting(), issuedAccess(), IssuedRegistrationAccessToken, issueRegistrationAccessToken(), IssueRegistrationAccessTokenInput, issueRegistrationAccessTokenValue() (+11 more)

### Community 24 - "rejectCrossOriginRequest"
Cohesion: 0.17
Nodes (15): apiError(), POST, postHandler(), apiError(), POST, postHandler(), patchHandler(), getHandler() (+7 more)

### Community 25 - "hashOpaqueToken"
Cohesion: 0.13
Nodes (20): POST, postHandler(), issueMfaChallenge(), createDatabaseSession(), isSessionIdle(), listUserSessions(), revokeDatabaseSession(), revokeOtherUserSessions() (+12 more)

### Community 26 - "selection.ts"
Cohesion: 0.16
Nodes (15): WorkspaceLayout(), activeFinancialStatuses, FinanceWorkspace(), money(), PaymentRecord, StaffMembership, StaffWorkspace(), focusableSelector (+7 more)

### Community 27 - "transactional-messages.ts"
Cohesion: 0.17
Nodes (21): formatMessageMoney(), attendeeName(), cancellationPaymentWording(), enqueueAttendeeSubstitutedMessage(), enqueuePaymentReceiptMessage(), enqueueRegistrationCancelledMessage(), enqueueRegistrationContactUpdatedMessage(), enqueueRegistrationTransferredNewContactMessage() (+13 more)

### Community 28 - "events/public-domain.ts"
Cohesion: 0.17
Nodes (19): buildPublicEventAnnouncementFeed(), calendarDateLabel(), describePublicEventLifecycle(), formatPublicEventSchedule(), isExactAllAttendeesAudience(), PublicAnnouncementCandidate, publicAnnouncementPlacementLabel(), PublicAnnouncementPriority (+11 more)

### Community 29 - "types.ts"
Cohesion: 0.14
Nodes (18): BalanceReminderCandidate, BalanceReminderPreviewContext, computeBalanceReminderPreview(), emailSchema, fingerprintPayload(), normalizedEmail(), skipReasonLabels, AnnouncementRecord (+10 more)

### Community 30 - "devDependencies"
Cohesion: 0.08
Nodes (25): eslint, eslint-config-next, devDependencies, eslint, eslint-config-next, prisma, tailwindcss, @tailwindcss/postcss (+17 more)

### Community 31 - "check-in/route.ts"
Cohesion: 0.26
Nodes (11): apiError(), applyPrivateHeaders(), authorize(), DELETE, deleteHandler(), json(), POST, postHandler() (+3 more)

### Community 32 - "communications-workspace.tsx"
Cohesion: 0.09
Nodes (28): CommunicationsPage(), communicationViews, emptyMessaging, metadata, ApiResult, canResendConfirmation(), CommunicationsWorkspace(), CommunicationsWorkspaceProps (+20 more)

### Community 33 - "square-domain.ts"
Cohesion: 0.12
Nodes (22): json(), noStoreHeaders, POST, postHandler(), parseSquareWebhookEvent(), record(), selectedCardPayment(), SquareCheckoutState (+14 more)

### Community 34 - "getPrisma"
Cohesion: 0.20
Nodes (15): getPrisma(), addStaffMembership(), listStaffMemberships(), setGlobalRole(), StaffMembershipRecord, updateStaffMembership(), removesActiveEventAdmin(), wouldRemoveLastActiveEventAdmin() (+7 more)

### Community 35 - "square-config.ts"
Cohesion: 0.13
Nodes (20): createSquarePayment(), CreateSquarePaymentInput, Fetcher, providerError(), record(), SquareAdapterError, SquarePaymentResult, SquarePaymentStatus (+12 more)

### Community 36 - "operational-health.ts"
Cohesion: 0.07
Nodes (41): hiddenRowsNotice(), metadata, money(), OperationalHealthPage(), SeverityBadge(), severityLabel(), timeLabel(), words() (+33 more)

### Community 37 - "logError"
Cohesion: 0.12
Nodes (24): errorResponse(), noStoreHeaders, POST, postHandler(), errorResponse(), lifecycleActionSchema, noStoreHeaders, postHandler() (+16 more)

### Community 38 - "service.ts"
Cohesion: 0.31
Nodes (18): getRateLimitConfiguration(), hashRateLimitIdentifier(), rateLimitClientIdentityHash(), rateLimitSubjectHash(), enforceRateLimitRules(), checkLoginAccountRateLimit(), checkLoginClientRateLimit(), checkPasswordResetAccountRateLimit() (+10 more)

### Community 39 - "registrations/repository.ts"
Cohesion: 0.14
Nodes (15): getRegistrationByIdWithClient(), getRegistrationQuery(), moneyToCents(), recordFromJson(), recordsFromJson(), RegistrationAttendeeOperationError, RegistrationAttendeeOperationErrorCode, RegistrationReadClient (+7 more)

### Community 40 - "scripts"
Cohesion: 0.09
Nodes (22): scripts, admin:create, admin:reset-mfa, build, db:deploy, db:generate, db:migrate, db:refresh-demo (+14 more)

### Community 41 - "organizations/repository.ts"
Cohesion: 0.07
Nodes (50): PATCH, patchHandler(), POST, postHandler(), PATCH, patchHandler(), GET, getHandler() (+42 more)

### Community 42 - "amendments-repository.ts"
Cohesion: 0.12
Nodes (31): errorResponse(), postHandler(), AmendmentActor, AmendmentInputAttendee, amendmentPreview(), AmendmentRegistration, amendmentSnapshot(), amendRegistration() (+23 more)

### Community 43 - "payment/route.ts"
Cohesion: 0.16
Nodes (15): applyPrivateHeaders(), errorResponse(), GET, getHandler(), json(), operationErrorResponse(), POST, postHandler() (+7 more)

### Community 44 - "[token]/route.ts"
Cohesion: 0.14
Nodes (18): applyPrivateHeaders(), errorResponse(), GET, getHandler(), json(), PATCH, patchHandler(), privateHeaders (+10 more)

### Community 45 - "dependencies"
Cohesion: 0.12
Nodes (17): @fontsource/noto-sans, lucide-react, next, dependencies, @fontsource/noto-sans, lucide-react, next, qrcode (+9 more)

### Community 46 - "registration-attendee-route.test.ts"
Cohesion: 0.40
Nodes (3): POST, context, mocks

### Community 47 - "retryMessage"
Cohesion: 0.16
Nodes (15): MessageRetryFingerprintInput, messageRetryIdempotencyKey(), messageRetryRequestFingerprint(), asMessagingDeliveryError(), replayMessageRetryOperation(), retryMessage(), retryMessageLocally(), serializeMessage() (+7 more)

### Community 48 - "[token]/page.tsx"
Cohesion: 0.16
Nodes (14): expiryLabel(), metadata, money(), moneyFormatter, PublicManagePage(), PublicManagePageProps, submittedLabel(), PublicAttendeePasses() (+6 more)

### Community 50 - "resolveEventContext"
Cohesion: 0.16
Nodes (19): CheckInPage(), metadata, FinancePage(), metadata, EventSettingsPage(), metadata, metadata, ProgramAssignmentsPage() (+11 more)

### Community 51 - "forms/repository.ts"
Cohesion: 0.18
Nodes (20): metadata, RegistrationBuilderPage(), getFormTemplate(), summarizeChoiceUsage(), createRegistrationForm(), createTestSubmission(), definitionFromJson(), FormWithVersions (+12 more)

### Community 52 - "registrations/schemas.ts"
Cohesion: 0.12
Nodes (17): attendeeInputSchema, AttendeeSubstitutionInput, attendeeSubstitutionInputSchema, emailField, operationIdentityFields, registrationAmendmentAttendeeSchema, RegistrationAmendmentInput, registrationAmendmentInputSchema (+9 more)

### Community 53 - "auth-service.ts"
Cohesion: 0.16
Nodes (19): POST, postHandler(), resetSchema, AccountTokenIssue, authenticateWithPassword(), describeAccountToken(), issueAccountToken(), PasswordAuthentication (+11 more)

### Community 54 - "wr26-bundle.ts"
Cohesion: 0.15
Nodes (27): attendeeFormType(), attendeeType(), calendarDate(), cell(), cents(), countsBy(), CsvTable, formChoice() (+19 more)

### Community 55 - "20260722190000_foundation/migration.sql"
Cohesion: 0.34
Nodes (14): "Announcement", "AuditLog", "CheckIn", "Event", "EventMembership", "Household", "HouseholdMember", "ImportRun" (+6 more)

### Community 56 - "[registrationId]/route.ts"
Cohesion: 0.15
Nodes (17): POST, postHandler(), POST, postHandler(), apiError(), GET, getHandler(), PATCH (+9 more)

### Community 57 - "applyRateLimitHeaders"
Cohesion: 0.18
Nodes (14): noStoreHeaders, postHandler(), promoQuoteError(), GET, getHandler(), privateHeaders, privateJson(), RouteContext (+6 more)

### Community 58 - "dashboard.ts"
Cohesion: 0.23
Nodes (12): activeRegistrationStatuses, buildSystemAdminDashboard(), eventTiming(), registrationBalance(), SystemAdminDashboard, SystemAdminDashboardSource, SystemAdminEventSource, getSystemAdminDashboard() (+4 more)

### Community 59 - "login/route.ts"
Cohesion: 0.16
Nodes (12): loginSchema, POST, postHandler(), POST, postHandler(), requestSchema, issuePasswordReset(), mergeRateLimitOutcomes() (+4 more)

### Community 61 - "totp.ts"
Cohesion: 0.24
Nodes (14): RFC-4226, RFC-4648, decodeBase32(), encodeBase32(), generateTotpSecret(), otpauthUri(), totpCode(), totpCodeForStep() (+6 more)

### Community 62 - "editor-draft.ts"
Cohesion: 0.21
Nodes (15): currentPromoCodeEditorDraft(), emptyPromoCodeEditorDraft(), isPromoCodeEditorDraftDirty(), normalizedDate(), normalizedDiscountType(), NormalizedPromoCodeEditorDraft, normalizedScaledNumber(), normalizePromoCodeEditorDraft() (+7 more)

### Community 63 - "resolve/route.ts"
Cohesion: 0.39
Nodes (7): applyPrivateHeaders(), errorResponse(), json(), lookupSchema, postHandler(), privateHeaders, RouteContext

### Community 64 - "request-context.ts"
Cohesion: 0.11
Nodes (17): POST, PATCH, updateSchema, eventIdSchema, GET, noStoreHeaders, DescribedError, emit() (+9 more)

### Community 65 - "reminder-messaging-repository.test.ts"
Cohesion: 0.20
Nodes (9): MessagingError, DEFAULT_MESSAGE_TEMPLATES, baseTransaction(), confirmationFixture(), ConfirmationMessage, event, mocks, money() (+1 more)

### Community 66 - "mfa-service.ts"
Cohesion: 0.10
Nodes (34): actionSchema, apiError(), GET, getHandler(), POST, postHandler(), derivedKey(), isSecretEncryptionConfigured() (+26 more)

### Community 67 - "announcements/route.ts"
Cohesion: 0.23
Nodes (10): PATCH, patchHandler(), announcementSchema, apiError(), GET, getHandler(), POST, postHandler() (+2 more)

### Community 68 - "outbox-sweep.ts"
Cohesion: 0.20
Nodes (13): POST, postHandler(), processAccountEmailQueue(), processPendingMessages(), getOutboxQueueSnapshot(), isAuthorizedSweepRequest(), OutboxQueueHealth, OutboxQueueSnapshot (+5 more)

### Community 69 - "app-shell.tsx"
Cohesion: 0.16
Nodes (11): metadata, NoAccessPage(), AppShell(), navigation, NavigationItem, ShellEvent, ShellUser, systemNavigation (+3 more)

### Community 70 - "prisma.ts"
Cohesion: 0.11
Nodes (24): GET, getHandler(), globalForPrisma, assessOutboxQueue(), getOutboxQueueHealth(), AlertScanResult, assessSystemSignals(), readSystemSignals() (+16 more)

### Community 71 - "access/authorization.ts"
Cohesion: 0.09
Nodes (28): apiError(), GET, getHandler(), membershipSchema, POST, postHandler(), GET, getHandler() (+20 more)

### Community 72 - "client.ts"
Cohesion: 0.25
Nodes (7): createSquarePayment(), getSquareConfiguration(), SQUARE_HOSTS, SquareConfigurationError, SquareEnvironment, SquarePaymentInput, SquarePaymentResult

### Community 73 - "package.json"
Cohesion: 0.22
Nodes (8): engines, node, name, overrides, postcss, sharp, private, version

### Community 74 - "registration-operations-repository.test.ts"
Cohesion: 0.22
Nodes (8): actor, baseRegistration(), fixture(), messageMocks, now, prismaMocks, registrationMocks, transferInput

### Community 75 - "[eventId]/attendee-passes/[attendeeId]/qr/route.ts"
Cohesion: 0.28
Nodes (7): GET, getHandler(), privateHeaders, privateJson(), RouteContext, context, mocks

### Community 76 - "account-email.ts"
Cohesion: 0.12
Nodes (23): ForgotPasswordPage(), metadata, PasswordResetRequestForm(), logInfo(), issueAccountTokenForUser(), revokeAccountToken(), accountEmailContent(), AccountEmailPurpose (+15 more)

### Community 77 - "getServerEnv"
Cohesion: 0.19
Nodes (13): getServerEnv(), logWarn(), currentCorrelationId(), BreachCheckResult, checkPasswordAgainstBreachCorpus(), isBreachCheckEnabled(), parseRange(), isAlertDeliveryConfigured() (+5 more)

### Community 78 - "promo-code-routes.test.ts"
Cohesion: 0.18
Nodes (11): PATCH, GET, POST, POST, dependencies, promoInput, publicContext, quoteRequest() (+3 more)

### Community 79 - "[eventId]/registrations/route.ts"
Cohesion: 0.43
Nodes (7): apiError(), authorize(), GET, getHandler(), POST, postHandler(), createRegistration()

### Community 80 - "next.config.ts"
Cohesion: 0.33
Nodes (4): nextConfig, privateRegistrationHeaders, sharedSecurityHeaders, squareFontOrigins

### Community 81 - "20260723010000_messaging_outbox/migration.sql"
Cohesion: 0.60
Nodes (5): "EventMessageSettings", "EventMessageTemplate", "MessageDeliveryAttempt", "MessageOutbox", "MessageTemplateVersion"

### Community 82 - "lifecycle.ts"
Cohesion: 0.18
Nodes (14): ActiveRegistrationStatus, calendarDateInEventTimeZone(), CapacityDecision, decideEventCapacity(), evaluateEventRegistrationAdmission(), evaluateEventRegistrationPhase(), EventAdmissionSource, EventLifecycleSource (+6 more)

### Community 83 - "definition.ts"
Cohesion: 0.07
Nodes (29): attendeeDisplayName(), attendeeNameKeys, AttendeeRosterConfig, availabilityModes, calculateRosterTotal(), calendarDateSchema, campMeetingHousingOptions, campMeetingNights (+21 more)

### Community 84 - "demo-data.ts"
Cohesion: 0.40
Nodes (4): demoAnnouncements, demoEvent, demoMetrics, demoPeople

### Community 85 - "csv-parser.ts"
Cohesion: 0.14
Nodes (15): attendeeTypeSchema, createImportSnapshotIdentity(), CsvImportError, importColumns, normalizeDate(), NormalizedImportData, normalizeHeader(), parseCsvMatrix() (+7 more)

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
Cohesion: 0.20
Nodes (16): metadata, answerLabel(), answerValue(), dateTime(), fieldLabelsFromDefinition(), initials(), LifecycleAction, lifecycleCopy (+8 more)

### Community 118 - "resend.ts"
Cohesion: 0.13
Nodes (14): cleanHeaderText(), EmailDeliveryInput, EmailDeliveryResult, EmailProviderConfigurationError, EmailProviderRequestError, ResendEmailConfiguration, sendEmailWithResend(), resetServerEnvCache() (+6 more)

### Community 119 - "public-access/domain.ts"
Cohesion: 0.23
Nodes (14): cents(), defaultRegistrationAccessExpiry(), describePublicRegistrationStatus(), isRegistrationAccessToken(), jsonRecord(), nonEmptyString(), publicAttendeeName(), publicContactFromSnapshot() (+6 more)

### Community 120 - "payment-choice/route.ts"
Cohesion: 0.18
Nodes (12): applyPrivateHeaders(), errorResponse(), json(), operationErrorResponse(), POST, postHandler(), privateHeaders, RouteContext (+4 more)

### Community 121 - "resend/route.ts"
Cohesion: 0.15
Nodes (15): POST, postHandler(), ResendWebhookConfigurationError, ResendWebhookEvent, resendWebhookEventSchema, ResendWebhookVerificationError, verifyResendWebhook(), finalizeSuccessfulAttempt() (+7 more)

### Community 122 - "rate-limit/domain.ts"
Cohesion: 0.22
Nodes (10): bindingDecision(), normalizeIpCandidate(), RateLimitConfiguration, RateLimitConfigurationError, RateLimitEnvironment, rateLimitHeaders(), supportedIpHeaders, trustedClientIp() (+2 more)

### Community 123 - "env.ts"
Cohesion: 0.17
Nodes (13): onRequestError(), register(), assertServerEnvAtStartup(), isServerEnvironmentError(), optionalTrimmed, readSource(), ServerEnv, ServerEnvironmentError (+5 more)

### Community 124 - "rate-limit/repository.ts"
Cohesion: 0.21
Nodes (10): RateLimitDecision, assertRule(), consumeRateLimitRule(), deleteExpiredRateLimitBuckets(), deleteExpiredRateLimitBucketsIfDue(), IncrementedBucket, nextCleanupAtByClient, RateLimitClient (+2 more)

### Community 125 - "password-policy.ts"
Cohesion: 0.20
Nodes (17): COMMON_PASSWORD_BASES, LEET_SUBSTITUTIONS, applyLeetSubstitutions(), characterCount(), hasControlCharacters(), isSequential(), normalize(), passwordCandidates() (+9 more)

### Community 126 - "badges/page.tsx"
Cohesion: 0.33
Nodes (11): metadata, PrintableNameBadgesPage(), BadgeLabel, BadgeTemplateId, badgeTemplateIds, badgeTemplates, buildBadgeLabels(), normalizeBadgeStartingPosition() (+3 more)

### Community 127 - "IMSDA Events"
Cohesion: 0.14
Nodes (14): Account email, Architecture, Build status and next review gate, Current API, Database commands, Design direction, IMSDA Events, Local setup (+6 more)

### Community 128 - "global-role/route.ts"
Cohesion: 0.24
Nodes (7): apiError(), globalRoleSchema, PATCH, patchHandler(), MembershipOperationError, mocks, params

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

### Community 133 - "import-workspace.tsx"
Cohesion: 0.27
Nodes (11): actionTone(), differenceLabel(), differenceValue(), ImportDifference, importDifferences(), ImportRecordView, ImportRunView, ImportWorkspace() (+3 more)

### Community 134 - "IMSDA Events build status and WR26 feature audit"
Cohesion: 0.17
Nodes (12): Behaviors not to copy from WR26, Capacity and event programs, Confirmation emails and notifications, Event-day operations, Important scope boundaries, IMSDA Events build status and WR26 feature audit, Payments, Recommended build order (+4 more)

### Community 135 - "checkin/repository.ts"
Cohesion: 0.23
Nodes (9): activeRegistrationStatusSet, checkInAttendee(), CheckInOperationDisposition, CheckInOperationError, retryableTransactionError(), undoCheckIn(), checkInRecord(), dependencies (+1 more)

### Community 136 - "shirt-sizes.ts"
Cohesion: 0.18
Nodes (14): confirmationLabel(), PublicShirtSizeConfirmation(), PublicShirtSizeConfirmationProps, SaveState, ShirtSizeAttendee, attendeeShirtSizeSchema, PublicShirtSizeConfirmationInput, publicShirtSizeConfirmationSchema (+6 more)

### Community 137 - "serializeRegistrationAccess"
Cohesion: 0.43
Nodes (7): confirmRegistrationShirtSizesWithClient(), eventUsesConventionShirts(), jsonRecord(), loadActiveAccessRecord(), moneyToCents(), serializeRegistrationAccess(), updateRegistrationContactWithClient()

### Community 138 - "[eventSlug]/page.tsx"
Cohesion: 0.22
Nodes (8): generateMetadata(), PublicEventPage(), PublicEventPageProps, getPublicEventLanding, landing, landingMocks, now, prismaMocks

### Community 139 - "Deploying with Docker (xCloud "Deploy Any App From Git" and similar)"
Cohesion: 0.18
Nodes (11): Alerting, Backups and restore rehearsals, Default local development is unchanged, `dependency failed to start: container ...-app-1 is unhealthy`, Deploying with Docker (xCloud "Deploy Any App From Git" and similar), Environment variables (set these in the xCloud env panel), `error: OUTBOX_SWEEP_TOKEN: set this to at least 32 random characters ...`, First-deploy checklist (+3 more)

### Community 140 - "shirt-sizes/route.ts"
Cohesion: 0.15
Nodes (13): applyPrivateHeaders(), errorResponse(), json(), PATCH, patchHandler(), privateHeaders, RouteContext, confirmPublicRegistrationShirtSizes() (+5 more)

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

### Community 174 - "registration-amendment-editor.tsx"
Cohesion: 0.26
Nodes (11): AmendmentField(), AmendmentPreview, attendeeIdentityKeys, DraftAttendee, labelWithRequired(), money(), protectedRegistrationKeys(), RegistrationAmendmentEditor() (+3 more)

### Community 175 - "challenge/route.ts"
Cohesion: 0.39
Nodes (8): challengeSchema, mfaErrorResponse(), POST, postHandler(), beginEnrollmentFromChallenge(), completeMfaChallenge(), describeMfaChallenge(), liveChallenge()

### Community 176 - "normalizePromoCode"
Cohesion: 0.31
Nodes (8): metadata, PromoCodesPage(), normalizePromoCode(), createPromoCode(), isUniqueConstraint(), listPromoCodes(), serializePromoCode(), updatePromoCode()

### Community 177 - "promo-codes/schemas.ts"
Cohesion: 0.20
Nodes (9): calendarDateSchema, optionalDateSchema, PromoCodeInput, promoCodeInputSchema, promoCodeShape, PublicPromoCodeQuoteInput, quoteAttendeeSchema, UpdatePromoCodeInput (+1 more)

### Community 178 - "more/page.tsx"
Cohesion: 0.27
Nodes (8): metadata, MorePage(), MfaManager(), MfaStatus, SessionManager(), SignedInSession, when(), listRecentAuditActivity()

### Community 179 - "passes/page.tsx"
Cohesion: 0.36
Nodes (6): eventDateLabel(), metadata, PrintableAttendeePassesPage(), PrintReportButton(), attendeePassIsAvailable(), activeRegistrationStatuses

### Community 180 - "events/schemas.ts"
Cohesion: 0.22
Nodes (6): calendarDateSchema, EventLifecycleInput, eventLifecycleInputSchema, EventSettingsInput, lifecycleFields, publicInfoUrlSchema

### Community 181 - "square-payment-repository.test.ts"
Cohesion: 0.25
Nodes (6): ParsedSquareWebhookEvent, configuration, dependencies, formDefinition, registration(), transactionClient()

### Community 182 - "admin/page.tsx"
Cohesion: 0.39
Nodes (7): dateRange(), metadata, money(), phaseLabel(), platformModules, statusLabel(), SystemAdminPage()

### Community 183 - "logger.test.ts"
Cohesion: 0.25
Nodes (4): describeError(), MESSAGE_SAFE_ERROR_NAMES, lines, MessagingError

### Community 184 - "[formSlug]/registrations/route.ts"
Cohesion: 0.17
Nodes (12): errorResponse(), GET, getHandler(), noStoreHeaders, POST, postHandler(), retryableTransactionError(), submitPublicRegistration() (+4 more)

### Community 185 - "promo-code-workspace.tsx"
Cohesion: 0.46
Nodes (7): availabilityLabel(), discountLabel(), money(), optionalIntegerValue(), optionalMoneyValue(), PromoCodeWorkspace(), PromoCodeRecord

### Community 186 - "getEventPublishReadiness"
Cohesion: 0.36
Nodes (6): EventReadinessItem, EventReadinessSource, getEventPublishReadiness(), hasText(), isPublicWebUrl(), validEvent

### Community 189 - "registration-amendment-route.test.ts"
Cohesion: 0.29
Nodes (5): POST, attendee, baseBody, context, mocks

### Community 190 - "overview/page.tsx"
Cohesion: 0.52
Nodes (6): formatEventDates(), metadata, money(), OverviewPage(), registrationSummary(), getEventOverview()

### Community 191 - "verify-public-registration-capacity.ts"
Cohesion: 0.40
Nodes (5): cleanup(), definition, main(), prisma, testEmails

### Community 192 - "reset-password/page.tsx"
Cohesion: 0.50
Nodes (3): metadata, ResetPasswordPage(), PasswordResetForm()

## Knowledge Gaps
- **836 isolated node(s):** `metadata`, `PublicManagePageProps`, `moneyFormatter`, `metadata`, `metadata` (+831 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **32 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getPrisma()` connect `getPrisma` to `program-assignments/repository.ts`, `payment-choice-repository.ts`, `email-delivery.ts`, `promo-codes/repository.ts`, `checkin/repository.ts`, `events/repository.ts`, `attendee-pass-repository.ts`, `forms/public-repository.ts`, `imports/repository.ts`, `getCurrentSession`, `lifecycle-repository.ts`, `square-repository.ts`, `operations-repository.ts`, `messaging-repository.ts`, `public-access/repository.ts`, `hashOpaqueToken`, `selection.ts`, `events/public-domain.ts`, `communications-workspace.tsx`, `operational-health.ts`, `logError`, `service.ts`, `registrations/repository.ts`, `organizations/repository.ts`, `amendments-repository.ts`, `challenge/route.ts`, `retryMessage`, `normalizePromoCode`, `more/page.tsx`, `forms/repository.ts`, `resolveEventContext`, `auth-service.ts`, `[formSlug]/registrations/route.ts`, `[registrationId]/route.ts`, `dashboard.ts`, `overview/page.tsx`, `listPublicEventSitemapEntries`, `mfa-service.ts`, `announcements/route.ts`, `outbox-sweep.ts`, `prisma.ts`, `account-email.ts`, `getServerEnv`, `lifecycle.ts`, `resend/route.ts`, `rate-limit/repository.ts`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._
- **Why does `logError()` connect `logError` to `global-role/route.ts`, `email-delivery.ts`, `forms/route.ts`, `events/repository.ts`, `shirt-sizes/route.ts`, `forms/public-repository.ts`, `getCurrentSession`, `square-repository.ts`, `reports/route.ts`, `rejectCrossOriginRequest`, `check-in/route.ts`, `square-domain.ts`, `organizations/repository.ts`, `payment/route.ts`, `[token]/route.ts`, `challenge/route.ts`, `auth-service.ts`, `logger.test.ts`, `[registrationId]/route.ts`, `applyRateLimitHeaders`, `[formSlug]/registrations/route.ts`, `login/route.ts`, `resolve/route.ts`, `request-context.ts`, `mfa-service.ts`, `announcements/route.ts`, `outbox-sweep.ts`, `prisma.ts`, `access/authorization.ts`, `[eventId]/attendee-passes/[attendeeId]/qr/route.ts`, `account-email.ts`, `[eventId]/registrations/route.ts`, `payment-choice/route.ts`, `resend/route.ts`, `rate-limit/repository.ts`?**
  _High betweenness centrality (0.099) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `@prisma/client`, `package.json`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **Are the 47 inferred relationships involving `findActiveMembership()` (e.g. with `patchHandler()` and `getHandler()`) actually correct?**
  _`findActiveMembership()` has 47 INFERRED edges - model-reasoned connections that need verification._
- **What connects `metadata`, `PublicManagePageProps`, `moneyFormatter` to the rest of the system?**
  _836 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `checkin/domain.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12121212121212122 - nodes in this community are weakly interconnected._
- **Should `program-assignments/repository.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05285592497868713 - nodes in this community are weakly interconnected._