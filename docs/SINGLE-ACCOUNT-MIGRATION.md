# Single account per person: migration plan (#554)

Companion to [ADR 0013](decisions/0013-one-account-per-person.md). Status: plan only. This
PR changes no schema, session, sign-in or behaviour. It adds the plan, a read-only dry run
(`npm run accounts:dry-run`) and tests.

Model in one line: **two tables stay; a unique nullable `User.attendeeAccountId` links a
staff `User` to the same person's `AttendeeAccount`.** Nothing is copied or moved between
tables, which is why every rollback below is small. If the project later chooses a physical
merge instead (ADR open question 2), the same inventory applies and the "Physical merge"
column of each group says what would have to be repointed.

**Human gates (AGENTS.md).** Linking identities, production migrations and production data
steps are human-approved. Nothing here runs from CI against production, and no step
below links anyone automatically.

**Data rule.** Dry-run output is personal data once `--show-emails` is used. Never paste it
into issues, pull requests, chat, logs or commits. The default output is counts, masked
emails and internal ids only.

## 1. Every model that references User or AttendeeAccount

Found by reading `prisma/schema.prisma` at `4e62ece`: **109 models, 170 columns**, plus the
two identity tables themselves. (ADR 0013's "about forty tables" undercounted.) 48 of the
columns are plain strings with **no foreign key**, so the database neither cascades nor
checks them; they matter for any merge and for the orphan checks in section 6.

Four more tables hang off these indirectly (no direct column):
`MfaRecoveryCode` (via `UserMfaEnrollment`), `AttendeeMfaRecoveryCode` (via
`AttendeeMfaEnrollment`), `UserPasskeyChallenge` (via `UserSession`) and
`AttendeePasskeyChallenge` (via `AttendeeSession`).

Two kinds of reference are **not** columns:

- `Registration` and `Person` reach an account **only by verified email**
  (`registrations-repository.ts`, ADR 0003). There is no account id on a registration, so
  linking never moves one. This is the registrations count in the dry run.
- Audit history that lives in JSON (`AuditLog.metadata`) may mention ids. It is history and
  is never rewritten.

### Groups and what each means

| Group | Meaning | Slices (a)-(c) | Link apply (d) | Physical merge (not planned) |
| --- | --- | --- | --- | --- |
| **S1** | Staff sign-in and session tables (`User`) | unchanged | untouched | keep; one credential set survives |
| **S2** | Attendee sign-in and session tables (`AttendeeAccount`) | unchanged | `AttendeeCredential.disabledAt` set for people with staff access (reversible); nothing else | retire after the rollback window |
| **R** | Role grants: event memberships (User), club director, Area Coordinator, location coordinator, accepted club invite (AttendeeAccount) | unchanged | untouched; roles stay on their side and are read through the link | repoint the staff-side rows |
| **L** | Person links (`UserPersonLink`, `AttendeeAccountPersonLink`) | unchanged | a mismatch between the two blocks the pair | keep one |
| **C** | Attendee-owned content: community participation, posts, reports, notifications; outbox recipients | unchanged | untouched | repoint `accountId` columns |
| **U** | Actor column pointing at `User`, with FK | unchanged | untouched; history keeps its original actor | rewrite id to survivor |
| **Un** | Actor column pointing at `User`, plain string, no FK | unchanged | untouched | rewrite id; no database help |
| **A** | Actor column pointing at `AttendeeAccount`, with FK | unchanged | untouched | rewrite id to survivor |
| **An** | Actor column pointing at `AttendeeAccount`, plain string, no FK | unchanged | untouched | rewrite id; no database help |

Dual-actor models (a row may record either a User or an AttendeeAccount as the actor), 24 of
them: AreaCoordinatorGrant, AttendeeAccountPersonLink, ClubDirectorGrant, ClubEventRegistration,
ClubFormLink, ClubFormSubmission, ClubInvite, ClubMeetingNote, ClubMonthlyReport,
ClubRegistrationDraft, ClubRosterExportFormat, ClubRosterMember, ClubSupplyOrderBatch,
ClubSupplyStock, ClubYearEndReport, CommunityPost, CommunityReport, DriverVerification,
MemberHonorEntry, MemberHonorEntryVoid, MemberTransfer, MemberTransferEvent, MessageOutbox,
RegistrationOperation. A person's history is the union of both columns:
`actorUserId = user.id OR actorAccountId = user.attendeeAccountId`. That one rule is what the
resolver helper in slice (b) should expose so no page reads the two columns separately.

### The inventory

| Model | Column | Points at | Constraint | Group |
| --- | --- | --- | --- | --- |
| AuthCredential | `userId` | User | FK, Cascade, required | S1 |
| UserSession | `userId` | User | FK, Cascade, required | S1 |
| StaffActAs | `userId` | User | FK, Cascade, required | S1 |
| UserMfaEnrollment | `userId` | User | FK, Cascade, required | S1 |
| MfaChallenge | `userId` | User | FK, Cascade, required | S1 |
| PasswordResetToken | `userId` | User | FK, Cascade, required | S1 |
| AttendeeIdentity | `accountId` | AttendeeAccount | FK, Cascade, required | S2 |
| AttendeeCredential | `accountId` | AttendeeAccount | FK, Cascade, required | S2 |
| AttendeeSession | `accountId` | AttendeeAccount | FK, Cascade, required | S2 |
| AttendeeAccountToken | `accountId` | AttendeeAccount | FK, Cascade, required | S2 |
| AttendeeMfaEnrollment | `accountId` | AttendeeAccount | FK, Cascade, required | S2 |
| AttendeeStepUpCode | `accountId` | AttendeeAccount | FK, Cascade, required | S2 |
| EventAsset | `uploadedByUserId` | User | FK, SetNull, optional | U |
| PlatformSettings | `updatedByUserId` | User | FK, SetNull, optional | U |
| ModuleRequest | `requestedByUserId` | User | FK, SetNull, optional | U |
| ModuleRequest | `decidedByUserId` | User | FK, SetNull, optional | U |
| EventLocation | `coordinatorAccountId` | AttendeeAccount | FK, SetNull, optional | R |
| RegistrationTagAssignment | `appliedByUserId` | User | FK, Restrict, required | U |
| RegistrationTagAssignment | `removedByUserId` | User | FK, Restrict, optional | U |
| AttendeeTagAssignment | `appliedByUserId` | User | FK, Restrict, required | U |
| AttendeeTagAssignment | `removedByUserId` | User | FK, Restrict, optional | U |
| StaffNote | `authorUserId` | User | FK, Restrict, required | U |
| StaffNoteRevision | `authorUserId` | User | FK, Restrict, required | U |
| EventMembership | `userId` | User | FK, Cascade, required | R |
| AttendeeAccountPersonLink | `accountId` | AttendeeAccount | FK, Cascade, required | L |
| AttendeeAccountPersonLink | `actorAttendeeAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| AttendeeAccountPersonLink | `actorUserId` | User | FK, SetNull, optional | U |
| UserPersonLink | `userId` | User | FK, Cascade, required | L |
| UserPersonLink | `actorUserId` | User | FK, Restrict, required | U |
| AreaCoordinatorGrant | `attendeeAccountId` | AttendeeAccount | FK, Cascade, required | R |
| AreaCoordinatorGrant | `grantedByUserId` | User | plain string, no FK, optional | Un |
| AreaCoordinatorGrant | `revokedByUserId` | User | plain string, no FK, optional | Un |
| ClubInvite | `createdByUserId` | User | FK, SetNull, optional | U |
| ClubInvite | `createdByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| ClubInvite | `acceptedAccountId` | AttendeeAccount | FK, SetNull, optional | R |
| ClubMonthlyReport | `submittedByAccountId` | AttendeeAccount | plain string, no FK, optional | An |
| ClubMonthlyReport | `updatedByAccountId` | AttendeeAccount | plain string, no FK, optional | An |
| ClubMonthlyReport | `updatedByUserId` | User | plain string, no FK, optional | Un |
| ClubYearEndReport | `submittedByAccountId` | AttendeeAccount | plain string, no FK, optional | An |
| ClubYearEndReport | `updatedByAccountId` | AttendeeAccount | plain string, no FK, optional | An |
| ClubYearEndReport | `updatedByUserId` | User | plain string, no FK, optional | Un |
| ClubMeetingNote | `createdByUserId` | User | FK, SetNull, optional | U |
| ClubMeetingNote | `updatedByUserId` | User | FK, SetNull, optional | U |
| ClubMeetingNote | `createdByAccountId` | AttendeeAccount | plain string, no FK, optional | An |
| ClubMeetingNote | `updatedByAccountId` | AttendeeAccount | plain string, no FK, optional | An |
| ClubYearStanding | `updatedByUserId` | User | plain string, no FK, optional | Un |
| ClubDirectorGrant | `attendeeAccountId` | AttendeeAccount | FK, Restrict, required | R |
| ClubDirectorGrant | `grantedByUserId` | User | FK, SetNull, optional | U |
| ClubDirectorGrant | `revokedByUserId` | User | FK, SetNull, optional | U |
| ClubDirectorGrant | `grantedByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| ClubDirectorGrant | `revokedByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| PersonMatchCandidate | `dismissedByUserId` | User | FK, SetNull, optional | U |
| RegistrationOperation | `actorUserId` | User | FK, Restrict, optional | U |
| RegistrationOperation | `actorAttendeeAccountId` | AttendeeAccount | FK, Restrict, optional | A |
| RegistrationAdjustment | `createdByUserId` | User | plain string, no FK, optional | Un |
| MerchandiseVariantAvailability | `createdByUserId` | User | FK, Restrict, required | U |
| MerchandiseOrder | `createdByUserId` | User | FK, SetNull, optional | U |
| MerchandiseOrderStatusChange | `actorUserId` | User | FK, Restrict, required | U |
| Announcement | `createdByUserId` | User | FK, default(Restrict), required | U |
| Announcement | `pinnedByUserId` | User | FK, SetNull, optional | U |
| EventCommunitySettings | `updatedByUserId` | User | FK, SetNull, optional | U |
| CommunityParticipation | `accountId` | AttendeeAccount | FK, Cascade, required | C |
| CommunityPost | `authorAccountId` | AttendeeAccount | FK, Cascade, required | C |
| CommunityPost | `moderatedByUserId` | User | FK, SetNull, optional | U |
| CommunityReport | `reporterAccountId` | AttendeeAccount | FK, Cascade, required | C |
| CommunityReport | `resolvedByUserId` | User | FK, SetNull, optional | U |
| CommunityNotification | `recipientAccountId` | AttendeeAccount | FK, Cascade, required | C |
| CommunityNotification | `actorAccountId` | AttendeeAccount | FK, Cascade, required | C |
| AuditLog | `actorUserId` | User | FK, SetNull, optional | U |
| ImportRun | `startedByUserId` | User | FK, default(Restrict), required | U |
| RegistrationForm | `createdByUserId` | User | FK, default(Restrict), required | U |
| RegistrationFormVersion | `createdByUserId` | User | FK, default(Restrict), required | U |
| EventTemplate | `createdByUserId` | User | FK, default(Restrict), required | U |
| EventTemplateVersion | `createdByUserId` | User | FK, default(Restrict), required | U |
| EventTemplateApplication | `actorUserId` | User | FK, default(Restrict), required | U |
| FormTestSubmission | `submittedByUserId` | User | FK, default(Restrict), required | U |
| EventPaymentInstructionVersion | `approvedByUserId` | User | FK, SetNull, optional | U |
| MessageTemplateVersion | `createdByUserId` | User | FK, SetNull, optional | U |
| MessageOutbox | `accountUserId` | User | FK, Cascade, optional | C |
| MessageOutbox | `accountAttendeeId` | AttendeeAccount | FK, Cascade, optional | C |
| ProgramAssignmentRun | `appliedByUserId` | User | FK, SetNull, optional | U |
| ClubSupplyStock | `updatedByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| ClubSupplyStock | `updatedByUserId` | User | FK, SetNull, optional | U |
| ClubSupplyOrderBatch | `createdByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| ClubSupplyOrderBatch | `createdByUserId` | User | FK, SetNull, optional | U |
| ClubSupplyOrderBatch | `receivedByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| ClubSupplyOrderBatch | `receivedByUserId` | User | FK, SetNull, optional | U |
| ClubRosterMember | `createdByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| ClubRosterMember | `createdByUserId` | User | FK, SetNull, optional | U |
| ClubRosterExportFormat | `createdByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| ClubRosterExportFormat | `createdByUserId` | User | FK, SetNull, optional | U |
| BackgroundCheckPre527 | `recordedByUserId` | User | plain string, no FK, optional | Un |
| BackgroundCheckUpload | `uploadedByUserId` | User | plain string, no FK, required | Un |
| BackgroundCheckEntry | `sourceUserId` | User | plain string, no FK, optional | Un |
| BackgroundCheckRejectedPairing | `rejectedByUserId` | User | plain string, no FK, required | Un |
| DriverVerification | `reviewedByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| DriverVerification | `reviewedByUserId` | User | FK, SetNull, optional | U |
| ClubEventRegistration | `submittedByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| ClubEventRegistration | `submittedByUserId` | User | FK, SetNull, optional | U |
| ClubEventAssignment | `updatedByUserId` | User | FK, SetNull, optional | U |
| ClubRegistrationDraft | `updatedByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| ClubRegistrationDraft | `updatedByUserId` | User | FK, SetNull, optional | U |
| MemberHonorEntry | `recordedByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| MemberHonorEntry | `recordedByUserId` | User | FK, SetNull, optional | U |
| MemberHonorEntryVoid | `voidedByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| MemberHonorEntryVoid | `voidedByUserId` | User | FK, SetNull, optional | U |
| MemberTransfer | `initiatedByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| MemberTransfer | `initiatedByUserId` | User | FK, SetNull, optional | U |
| MemberTransfer | `resolvedByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| MemberTransfer | `resolvedByUserId` | User | FK, SetNull, optional | U |
| MemberTransferEvent | `actorAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| MemberTransferEvent | `actorUserId` | User | FK, SetNull, optional | U |
| MemberTransferRegistrationMove | `decidedByUserId` | User | FK, SetNull, optional | U |
| CalendarEntry | `createdByUserId` | User | plain string, no FK, required | Un |
| CalendarEntry | `updatedByUserId` | User | plain string, no FK, required | Un |
| CalendarFeed | `createdByUserId` | User | plain string, no FK, required | Un |
| CalendarFeed | `updatedByUserId` | User | plain string, no FK, required | Un |
| AttendeePasskey | `accountId` | AttendeeAccount | FK, Cascade, required | S2 |
| UserPasskey | `userId` | User | FK, Cascade, required | S1 |
| EventCloneRecord | `actorUserId` | User | FK, default(Restrict), required | U |
| ClubFormTemplate | `enabledByUserId` | User | FK, SetNull, optional | U |
| ClubFormTemplate | `draftUpdatedByUserId` | User | plain string, no FK, optional | Un |
| ClubFormTemplateVersion | `createdByUserId` | User | plain string, no FK, optional | Un |
| ClubFormSubmission | `enteredByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| ClubFormSubmission | `enteredByUserId` | User | FK, SetNull, optional | U |
| ClubFormLink | `createdByAccountId` | AttendeeAccount | FK, SetNull, optional | A |
| ClubFormLink | `createdByUserId` | User | FK, SetNull, optional | U |
| OrganizationBillingContact | `verifiedByUserId` | User | FK, SetNull, optional | U |
| OrganizationBillingContact | `createdByUserId` | User | FK, SetNull, optional | U |
| OrganizationBillingContact | `endedByUserId` | User | FK, SetNull, optional | U |
| RegistrationBillingResponsibility | `setByUserId` | User | FK, SetNull, optional | U |
| RegistrationBillingResponsibilityChange | `actorUserId` | User | FK, SetNull, optional | U |
| AttendanceCorrection | `actorUserId` | User | FK, SetNull, optional | U |
| AttendanceReconciliationVersion | `preparedByUserId` | User | FK, SetNull, optional | U |
| AttendanceReconciliationVersion | `approvedByUserId` | User | FK, SetNull, optional | U |
| AttendanceReviewAcknowledgement | `actorUserId` | User | FK, SetNull, optional | U |
| GuardianAuthority | `actorUserId` | User | FK, SetNull, optional | U |
| GuardianAuthority | `revokedByUserId` | User | FK, SetNull, optional | U |
| GuardianAuthorityConflict | `resolvedByUserId` | User | FK, SetNull, optional | U |
| InvoiceVersion | `createdByUserId` | User | FK, SetNull, optional | U |
| InvoiceVersion | `finalizedByUserId` | User | FK, SetNull, optional | U |
| InvoiceDelivery | `sentByUserId` | User | FK, SetNull, optional | U |
| InvoiceDeliveryRecipient | `attendeeAccountId` | AttendeeAccount | plain string, no FK, optional | An |
| InvoiceArPosting | `recordedByUserId` | User | FK, SetNull, optional | U |
| InvoicePayment | `recordedByUserId` | User | FK, SetNull, optional | U |
| EventLodging | `settingsUpdatedByUserId` | User | plain string, no FK, optional | Un |
| EventLodging | `assignmentSettingsUpdatedByUserId` | User | plain string, no FK, optional | Un |
| EventLodging | `createdByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingUnit | `updatedByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingHold | `createdByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingHold | `releasedByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingHoldHistory | `actorUserId` | User | plain string, no FK, optional | Un |
| EventLodgingRate | `updatedByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingRequestVersion | `actorUserId` | User | plain string, no FK, optional | Un |
| EventLodgingRoommateRequest | `actorUserId` | User | plain string, no FK, optional | Un |
| EventLodgingRoommateRequest | `decidedByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingRoommateRequest | `withdrawnByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingRule | `actorUserId` | User | plain string, no FK, optional | Un |
| EventLodgingRule | `endedByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingReviewAck | `actorUserId` | User | plain string, no FK, optional | Un |
| EventLodgingChangeRequest | `resolvedByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingBucket | `updatedByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingPlaceholder | `createdByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingPlaceholder | `linkedByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingPlaceholder | `archivedByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingAssignment | `actorUserId` | User | plain string, no FK, optional | Un |
| EventLodgingAssignment | `cancelledByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingAssignmentHistory | `actorUserId` | User | plain string, no FK, optional | Un |
| EventLodgingAssignmentNotice | `sentByUserId` | User | plain string, no FK, optional | Un |
| EventLodgingWaitlistHistory | `actorUserId` | User | plain string, no FK, optional | Un |

## 2. What moves where

Under the link model, **no row moves** in any slice. The only data written, in order:

| Slice | Writes |
| --- | --- |
| (a) | One additive column `User.attendeeAccountId` (all `NULL`) and its unique index. |
| (b) | A verified `AttendeeAccount` for each *new* staff user at activation; for an existing attendee given a staff role, the new `User` is linked to their account. |
| (c) | Nothing in the data model. Sessions are issued by the new page into the existing session tables. |
| (d) | Per approved person: set `User.attendeeAccountId`; set `AttendeeCredential.disabledAt` when the person holds a staff role; one `AuditLog` row (`account.linked`, ids only). |
| (e) | Drop the code paths, then (separately, optional) the retired attendee credentials of linked people. |

## 3. Order of operations

1. **Before anything:** merge nothing until the director says to start (ADR, Oct 1 hold) and
   the Women's Retreat (Oct 9-11) is over.
2. Take a database backup (`scripts/backup`) and record its identifier in the approval note.
3. Run `npm run accounts:dry-run` against a **copy** of production, then against production
   (it only reads). Review counts and conflicts with the director. Do not share full emails.
4. Deploy slice (a)'s migration (human step). Verify with queries 6.1 and 6.2.
5. Deploy slices (b) and (c) behind the switch, off. Turn the switch on for staff testers,
   then for everyone after the retreat.
6. Apply links (slice (d)) one person per transaction, **clean pairs first**, then
   `needs-review` pairs after a person has chosen what survives, never `blocked` pairs until
   their blocker is resolved by hand.
7. Run section 6's queries after each batch. Keep the old sign-in pages for two weeks.
8. Slice (e) only after the window, in its own PR.

## 4. Backfill

- **Slice (a): none.** The migration adds the column empty.
- **Create (staff with no attendee account at their email).** For an ACTIVE staff user: create
  a verified attendee account with the same normalised email and the staff user's display
  name, and link it. Verified because staff activation already proved control of the email
  (ADR 0013). PENDING_ACTIVATION staff get theirs at activation instead.
- **Link (clean pair).** Set `User.attendeeAccountId` to the attendee account for the pair.
- **Needs review.** Skipped until a person records the choice for each conflict (section 8).
- **Blocked / ambiguous.** Skipped; reported.
- Each person is one transaction, re-runnable (the unique column makes a second run a
  no-op), audited, and refused without a recorded director approval. The apply tool is
  slice (d), not this PR.

## 5. Credentials, sessions and audit ids

| Item | What happens | Why |
| --- | --- | --- |
| **Passkeys** | Both tables stay. `UserPasskey` signs in with staff grade; `AttendeePasskey` signs in with attendee grade (attendee session only). WebAuthn credential ids are unique per registration, so the two sets cannot collide. Passkeys are **moved or merged for nobody**. | A passkey is bound to a relying party and key; copying one is not possible. Whether an attendee passkey may count as a staff second factor is a separate decision (open). |
| **MFA secrets** | Never copied or merged. Staff sign-in uses `UserMfaEnrollment`. `AttendeeMfaEnrollment` stays for attendee-grade sign-in and is retired in (e). If only the attendee side is enrolled, the person enrols on the staff side before staff access (required). | Two secrets cannot be reconciled, and the staff one is the one the staff rules protect. |
| **Recovery codes** | Stay with their enrollment. Staff codes are the ones that count. Attendee codes are deleted only when the attendee enrollment is retired in (e). | They are hashed and enrollment-bound. |
| **Passwords** | Both hashes are salted and cannot be compared, so "different passwords" is assumed. A staff session requires a staff credential (`AuthCredential` password or `UserPasskey`) plus the staff second factor, and nothing else; an attendee password, attendee passkey or Google only ever yields the attendee session, whatever second factor follows. The attendee credential is **disabled, not deleted** (`disabledAt`), so it can be re-enabled. | Reversible, and one password per person from the person's view. |
| **Sessions** | Not merged and not revoked at link time. Existing staff and attendee sessions stay valid so nobody is signed out mid-task. New sign-ins through the single page create both. Revoking staff ends the staff session only. | ADR 0013. |
| **Audit actor ids** | Never rewritten. `AuditLog.actorUserId` and every `...ByUserId` / `...ByAccountId` keep their original value. Reports union both columns through the link. One new `account.linked` row records the pair's ids. | History must stay true to who acted at the time; a rewrite is irreversible. |

## 6. Verification queries

Run read-only (for example with `psql` in a `BEGIN READ ONLY` block). Expected result is in
the comment. None prints an email.

```sql
-- 6.1 Slice (a): the column exists and is empty after deploy.        -- expect 0
SELECT count(*) FROM "User" WHERE "attendeeAccountId" IS NOT NULL;

-- 6.2 Linked pairs never differ in email.                            -- expect 0 rows
SELECT u."id" FROM "User" u
JOIN "AttendeeAccount" a ON a."id" = u."attendeeAccountId"
WHERE lower(btrim(u."email")) <> lower(btrim(a."email"));

-- 6.3 Every link is to a verified, enabled, active account.          -- expect 0 rows
SELECT u."id" FROM "User" u
JOIN "AttendeeAccount" a ON a."id" = u."attendeeAccountId"
WHERE a."emailVerifiedAt" IS NULL OR a."disabledAt" IS NOT NULL OR a."status" <> 'ACTIVE';

-- 6.4 No attendee account is linked to two users (the unique index   -- expect 0 rows
--     already forbids it; this proves it).
SELECT "attendeeAccountId" FROM "User"
WHERE "attendeeAccountId" IS NOT NULL
GROUP BY 1 HAVING count(*) > 1;

-- 6.5 Staff access still requires a second factor.                   -- expect 0 rows
SELECT u."id" FROM "User" u
WHERE (u."globalRole" IS NOT NULL
       OR EXISTS (SELECT 1 FROM "EventMembership" m WHERE m."userId" = u."id" AND m."status" = 'ACTIVE'))
  AND NOT EXISTS (SELECT 1 FROM "UserMfaEnrollment" e WHERE e."userId" = u."id" AND e."status" = 'ACTIVE')
  AND NOT EXISTS (SELECT 1 FROM "UserPasskey" p WHERE p."userId" = u."id" AND p."revokedAt" IS NULL);

-- 6.6 Row counts did not change across a link batch (compare to the  -- expect equal
--     counts taken before): User, AttendeeAccount (+ created ones),
--     Registration, EventMembership, ClubDirectorGrant, AreaCoordinatorGrant.
SELECT 'User', count(*) FROM "User" UNION ALL
SELECT 'AttendeeAccount', count(*) FROM "AttendeeAccount" UNION ALL
SELECT 'Registration', count(*) FROM "Registration" UNION ALL
SELECT 'EventMembership', count(*) FROM "EventMembership" UNION ALL
SELECT 'ClubDirectorGrant', count(*) FROM "ClubDirectorGrant" UNION ALL
SELECT 'AreaCoordinatorGrant', count(*) FROM "AreaCoordinatorGrant";

-- 6.7 Audit history untouched: per linked user, the AuditLog count   -- expect equal (+1 per link)
--     before and after.
SELECT u."id", count(l."id") FROM "User" u
LEFT JOIN "AuditLog" l ON l."actorUserId" = u."id"
WHERE u."attendeeAccountId" IS NOT NULL GROUP BY 1;

-- 6.8 Orphans in the 48 plain-string actor columns (template; run    -- expect 0 per column
--     once per Un/An row of the inventory, swapping table and column).
SELECT count(*) FROM "ClubMonthlyReport" r
LEFT JOIN "AttendeeAccount" a ON a."id" = r."submittedByAccountId"
WHERE r."submittedByAccountId" IS NOT NULL AND a."id" IS NULL;

-- 6.9 Disabled attendee passwords belong only to people with staff   -- expect 0 rows
--     access (a stray disable locks an attendee out).
SELECT c."accountId" FROM "AttendeeCredential" c
WHERE c."disabledAt" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."attendeeAccountId" = c."accountId");
```

`scripts/verify-single-account-dry-run.ts` (`npm run test:single-account-dry-run`) proves
the dry run itself changes nothing, using the same count, `updatedAt` and checksum idea over
23 tables.

## 7. Rollback, per slice

| Slice | Rollback | Data lost |
| --- | --- | --- |
| (a) | Migrations are roll-forward here, so rollback is a **new** migration `ALTER TABLE "User" DROP COLUMN "attendeeAccountId"`. Safe because nothing reads the column. Revert the PR if it has not been deployed. | None. |
| (b) | Turn the switch off. Links remain but nothing reads them. Attendee accounts created for new staff are ordinary verified accounts; list those with no registrations and no roles before deciding to delete any. | None. |
| (c) | Turn the switch off: `/login` and `/account/sign-in` serve their own pages again. Sessions issued by the new page are normal rows and stay valid. | None. |
| (d) | Per person: set `User.attendeeAccountId = NULL` and `AttendeeCredential.disabledAt = NULL`, in one audited transaction (the preview tool prints the exact statements). Because no row moved, this fully restores the pre-link state. Restore from the step-2 backup only if something unexpected was written. | None expected. |
| (e) | Not reversible once the old code is deleted; do it only after two weeks without a rollback. Restore requires redeploying the previous release and the backup. | Retired attendee credentials. |

## 8. Conflicts

The dry run reports each of these per pair. Severity: **blocking** = do not link until a
person resolves it; **review** = linkable, but a person chooses what survives; **info** =
nothing to decide.

| Situation | Code | Severity | Resolution |
| --- | --- | --- | --- |
| Same email, **different passwords** (hashes cannot be compared) | `BOTH_HAVE_PASSWORD` | review | Staff password survives for staff-grade sign-in. Attendee credential is disabled, not deleted. The person is told once. |
| A password is locked out on either side | `CREDENTIAL_LOCKED` | review | Wait for the lockout to clear, or reset it deliberately. |
| **Different MFA**: both sides enrolled | `MFA_BOTH_ENROLLED` | review | Staff secret survives; the attendee secret and recovery codes are retired in (e). |
| **Different MFA**: only the attendee side enrolled | `MFA_ATTENDEE_ONLY` | review | The person enrols on the staff side before staff access (required). |
| Authenticator lockout in force on either side | `MFA_LOCKED` | review | Wait for the lockout to clear, or reset it deliberately. |
| Staff role (global role or active membership) but **no confirmed authenticator and no passkey** | `STAFF_NO_SECOND_FACTOR` | blocking | Staff access requires a second factor; the person enrols before any link. |
| **Different names** (ignoring case, spacing, accents) | `NAME_MISMATCH` | review | A person picks the surviving display name. Nobody is renamed automatically. |
| **Disabled** attendee account | `ATTENDEE_DISABLED` | blocking | Find out whether it was deliberate (abuse, request). Do not link a person someone shut out. |
| **Disabled** staff password sign-in | `STAFF_CREDENTIAL_DISABLED` | blocking | Same question; re-enable only by a human. |
| Staff invited but never activated | `STAFF_NOT_ACTIVATED` | blocking | Wait for activation, which proves the email. |
| **Unverified** attendee email | `ATTENDEE_EMAIL_UNVERIFIED` | blocking | Verified-email claiming is the only basis for treating two rows as one person (ADR 0003). Verify first. |
| Accounts linked to different `Person` records | `PERSON_LINK_MISMATCH` | blocking | A person decides which `Person` is right. |
| Passkeys on both sides | `PASSKEYS_ON_BOTH` | info | Kept as two sets; never merged. |
| Attendee side signs in with Google | `ATTENDEE_GOOGLE_IDENTITY` | info | Opens the attendee side only, never staff. |
| Several rows share one normalised email on a side (for example two `User` rows, or two `AttendeeAccount` rows, differing only by case), **even with no row on the other side** | listed under "ambiguous" | blocking | Not paired and not counted as staff-only or attendee-only. A person resolves the duplicates first. |
| **Different emails** for the same person | not detected | n/a | Left separate by decision (Sept 28); only the two system administrators are affected. No linking tool. |

## 9. The dry run

```
npm run accounts:dry-run                    # counts, masked emails (j***@d***.org), internal ids
npm run accounts:dry-run -- --json
npm run accounts:dry-run -- --show-emails   # full emails; prints a personal-data warning on stderr
```

It pairs a staff `User` and an `AttendeeAccount` by normalised email (trim, lowercase, the
same rule sign-in uses), and for each pair reports the conflicts above plus counts on each side:

- staff: event memberships (active and total), global role, active passkeys, active
  sessions, audit rows (`AuditLog.actorUserId`), and `actorRows`: every other row the user
  authored;
- attendee: registrations reachable by that email (counted in SQL per account, so guest
  emails are never loaded), active club roles, Area Coordinator, active passkeys, active
  sessions, and `actorRows`: every row the account authored (`AuditLog` has no attendee
  actor column);
- `actorRows` on both sides is **complete by construction**: the list relations of `User`
  and `AttendeeAccount` are read from the Prisma schema at run time (everything except
  sign-in material, role grants, sessions and recipient rows), so a column added later is
  counted without editing the script. It covers the authored ones among the 122 columns of
  section 1 that have a Prisma relation field. The plain-string columns without a relation (the 48 "no FK" rows)
  cannot be counted this way; query 6.8 covers them;
- totals for staff-only and attendee-only accounts, and for ambiguous groups.

Emails are masked in the local part and the domain (`j***@d***.org`); only gmail.com,
yahoo.com, outlook.com, hotmail.com, icloud.com and aol.com keep their domain. Names, phone
numbers, hashes and secrets are never selected: display names are compared inside PostgreSQL
and only "the names differ" comes back. It is read-only
by construction: every query runs in one `SET TRANSACTION READ ONLY` transaction
(REPEATABLE READ), so PostgreSQL itself rejects a write; a unit test asserts that statement
comes first and the source holds no write call, and the real-database verify proves the
database refuses a write and that no row, `updatedAt` or checksum changed.
