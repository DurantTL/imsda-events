# Options report: health records, insurance, and UltraCamp transfer

Issue #389. Requested by Caleb Durant, September 23, 2026.

**This is a report of options, not a build.** Nothing here is approved, and no
health or insurance data may be stored until the decisions in the last section
are made and ADR 0005 is Accepted for these records.

This report is not legal advice. Where it says a law applies or doesn't, that is
the general reading; confirm it with the conference's legal counsel before
relying on it.

## What was asked for

Club rosters would hold, for each member:

- **health information** (conditions, allergies, medications);
- **insurance information** (carrier, policy and member numbers, card images);
- **uploaded health notices** (signed health forms, doctor's notes).

A new **Health** tab would show each member's documents. The records should be
handled as close to HIPAA practice as possible. Later, the Youth Director could
move these records to and from **UltraCamp** for summer camp. The UltraCamp API
is still unknown.

## The short answer

- **HIPAA almost certainly doesn't apply by law**, but its security practices
  are the right model. The laws that *do* apply are the state data-breach laws,
  and they cover this kind of data.
- **The platform already has the building blocks:** field-level encryption
  (`lib/secret-box.ts`), MFA on rosters, the audit log, and safe file uploads.
  Health records would reuse them instead of adding new systems.
- **Recommended shape:**
  - structured health fields, each encrypted separately;
  - optional document uploads, encrypted before they reach the disk;
  - a dedicated "health records" permission;
  - a "has a health note" flag for staff who only need to know that one exists;
  - every view audited;
  - records re-confirmed each club year.
- **UltraCamp:** start with a manual export the Youth Director uploads, not an
  automatic sync, until UltraCamp's API and security terms are known.
- **The key matters more than ever.** Losing `SECRET_ENCRYPTION_KEY` would lose
  every health record permanently. Nothing real is stored until the key backup
  on the server checklist exists and has been test-restored.

## 1. What HIPAA does and doesn't require of a church ministry

### When HIPAA applies

HIPAA's Privacy and Security Rules apply to **covered entities** and their
**business associates**:

- **Covered entities** are health plans, health care clearinghouses, and health
  care providers that send standard electronic transactions, such as billing an
  insurer.
- **Business associates** are vendors handling health records for a covered
  entity.

A conference, a Pathfinder club, or a camp collecting health forms so it can
care for children at events is generally **none of these**. It doesn't bill
insurance electronically, and it isn't acting for a covered entity. So HIPAA
generally does not govern these records, even when they hold diagnoses or
insurance numbers.

Edge cases to raise with counsel:
- a camp nurse or clinic that bills insurance;
- the conference's own employee health plan, which is a separate matter;
- a vendor contract that says the vendor "is HIPAA compliant". That describes
  the vendor, not what the conference owes.

### What does apply

- **State data-breach laws.**
  - Missouri's law (RSMo 407.1500) names medical information and health
    insurance information among the data whose breach must be reported.
  - Iowa's law (Iowa Code chapter 715C) also requires breach notice. Counsel
    should confirm exactly which kinds of data it covers.
  - A leak of these records would likely mean notifying families and possibly
    the state attorney general. That is the practical legal risk to design
    against.
- **Duty of care and trust.** Parents hand over their children's health details
  so leaders can keep those children safe. Handling them carelessly is a
  ministry failure even where no statute applies.
- **Camp standards.** If a camp is accredited (for example by the American Camp
  Association), its health-record standards apply to the camp's records. The
  Youth Director should confirm what the camp's accreditation, if any, requires.

### What "as close to HIPAA as possible" should mean here

HIPAA's Security Rule is a good checklist even where it isn't required. Adopt
its practices:

| HIPAA practice | What it means for this platform | Already in place? |
| --- | --- | --- |
| Minimum necessary | Each role sees only what it needs; most staff see a flag, not the note | Pattern exists: ages instead of birth dates (ADR 0005 Addendum A) |
| Access control | A dedicated permission, scoped to the club or event | Club grants and event roles exist; a health permission would be new |
| Unique user login + strong authentication | Everyone who can read records uses their own account with MFA | MFA is required to open a club roster |
| Audit controls | Every view, download, edit, export, and denied attempt is logged | `writeAuditLog` exists; reads would be logged, not only changes |
| Encryption at rest and in transit | Sealed fields and files; HTTPS only | `secret-box.ts`; HTTPS is on the server checklist |
| Integrity | Records can't be silently altered; corrections keep history | AES-GCM detects tampering; versioned corrections would be new |
| Backup and recovery | Records survive losing the server; the key survives too | Server checklist items 1–5 (not yet done) |
| Breach response | A written plan for who is told what, and when | Not yet written |
| Workforce training | Everyone with access knows the rules | Director onboarding (checklist item 10) could carry this |

A **business associate agreement** isn't needed with our own server. It would
matter only if a third-party service ever stored these records for us.

## 2. How the fields and documents would be encrypted and stored, and who sees them

### Structured fields

This follows the pattern ADR 0005 recommends and Addendum A already uses for
birth dates.

- **One encrypted value per field.** Each field is sealed with `sealSecret`
  under its own purpose string:
  - `health:conditions`;
  - `health:allergies`;
  - `health:medications`;
  - `health:insurance`.

  A key derived for one kind of record can't open another.
- **Separate plain flags** for status-only sharing: "has an allergy note",
  "carries an epinephrine injector", "has a medication at camp". These are
  booleans with no content.
  - Kitchen staff, transport staff, and check-in staff see the flag, never the
    note.
  - The flags are what make the data searchable, since encrypted text isn't.
- **Structured first.** Checkboxes and short choices wherever possible, with
  free text only for detail. Less free text means less to leak through an
  export, a log line, or a printed page.

### Uploaded documents

| Option | How it works | Pros | Cons |
| --- | --- | --- | --- |
| **A. Encrypted files on our server** (recommended) | Each upload is encrypted with a derived key (`health:document`) before it's written to disk, next to event assets. The database keeps only a label, type, size, and who uploaded it. Files are served only through an authorized download that is never cached. | Stays on-premises, matching the key-custody decision; reuses the upload checks in `modules/events/asset-storage.ts` (PDF, JPEG, PNG; signature-checked; generated names) and the existing nightly file backup | Files must sit where the backup archives them (see §3); large files cost disk space |
| **B. A third-party document vault** | A vendor stores the files; we keep a reference | Vendor handles storage and backups | Leaves the on-premises model; needs a vendor contract and security review; one more login and key to manage |
| **C. No uploads; structured fields only** | Paper forms stay with the club | The least risk, and the simplest | Doesn't meet the Health-tab request; paper gets lost |

Whichever option is chosen:
- keep uploads to PDF and images, capped at about 10 MB;
- don't generate thumbnails or previews, because a preview is a decrypted copy
  sitting somewhere;
- make downloads explicit, one at a time, with the reason recorded when someone
  outside the club opens them.

### Who could see what

A starting proposal. Every row is a decision to confirm.

| Role | Health fields | Insurance | Documents | Flags |
| --- | --- | --- | --- | --- |
| That club's Director and Deputy | View and edit | View and edit | View and upload | Yes |
| Club Registrar | Enter only (like birth dates) | Enter only | Upload only | Yes |
| Club Reporter | No | No | No | No |
| Area Coordinator | No | No | No | No |
| Event staff (registration, finance, check-in) | No | No | No | Yes, for their event |
| Event medical staff (camp nurse, first aid) | View, for people at their event | View | View | Yes |
| Youth Director (camp transfer) | View and export, audited | View and export, audited | View and export, audited | Yes |
| System administrator | Break-glass only: a stated reason, time-limited, reviewed | Break-glass only | Break-glass only | Yes |
| The member or parent (future, with guardian accounts) | View and correct their own | View and correct | View and upload their own | — |

The Health tab would be a new tab on the member's roster page. It would appear
only to roles with health access, behind the same MFA step as the roster.

## 3. How access is audited and how long data is kept

### Audit

- Log **every read**, not only changes. That covers opening the Health tab,
  viewing a field, downloading a document, exporting, and editing, plus every
  **denied** attempt.
- Audit entries record *who*, *what kind of record*, *whose record* (an ID, not
  a name), *when*, and *why* where a reason is required. They never contain the
  health content itself, just as birth dates are handled today.
- A monthly review by a named person of:
  - break-glass use;
  - exports;
  - anyone outside a club opening that club's records.

### Retention

Options, each a decision:

1. **Re-confirm every club year** (recommended). Health details go stale:
   medications change, and allergies are found or outgrown. At the start of
   each club year, last year's health fields and documents are shown as
   "needs updating". They are removed after a grace period (for example 60
   days) unless the director re-confirms them.
2. **Keep until the director removes the person**, the same as birth dates
   today. This is simpler, but stale records pile up.
3. **Delete a fixed time after each event.** This fits camp-only use but
   doesn't suit year-round clubs.

In every option:
- removing a person from the roster erases their health records at once;
- a **legal hold** (for example, after an incident) must be able to pause
  deletion. That needs a named owner, as ADR 0005 §4 already says.

### Backups

Database dumps hold only encrypted values, so a stolen dump is unreadable
without the key. Uploaded event files are already archived with each nightly
backup (`scripts/backup/assets-backup.sh`) and sent off-site by the same
`BACKUP_OFFSITE_COMMAND`. Two things would follow for health records:

- **Health documents must live where the archive looks** (the assets volume),
  or be added to it. Because each file is encrypted before it's written, the
  archive holds only encrypted copies.
- **Deleted records live on in backups** until those backups age out: 14 days
  by default (`BACKUP_RETENTION_DAYS`), plus however long the off-site copies
  are kept. The retention decision should say how long off-site copies are
  kept.

## 4. What the rest of ADR 0005 already decides

ADR 0005 is **Proposed**, except for Addendum A (roster birth dates), which is
**Accepted**. For health records it already sets:

- **Design direction (proposed):**
  - reuse `secret-box.ts` with separate purposes;
  - seal field by field, not one envelope per person;
  - plain flags for status-only sharing;
  - a dedicated permission;
  - break-glass with review;
  - audit reads and denials;
  - no automatic sharing across events;
  - corrections keep history;
  - exports audited and justified;
  - synthetic data only in testing.
- **Settled by Addendum A, and carried over here:**
  - key custodian: Jonathan Swena;
  - the key copy is kept on an external, on-premises server, apart from the
    database dumps;
  - nothing real is stored until the key copy has been test-restored;
  - MFA before any roster opens;
  - removal erases personal fields.
- **Still open in ADR 0005, and blocking health records:**
  - confirm the record classes (§1);
  - the rotation schedule (§2);
  - who holds the health permission, and who reviews break-glass use (§3);
  - the retention schedule and the legal-hold owner (§4);
  - sign-off from the privacy, security, legal, ministry-operations, and
    key-operations owners.

Addendum A says plainly that it **does not approve medical, insurance, or
background-check data**. A new **Addendum B: club health records** would record
the decisions in §6 below. It follows the same pattern as Addendum A.

## 5. What's needed from UltraCamp

The UltraCamp API is unknown, so nothing about it is assumed here. Before any
transfer is designed, the Youth Director (or whoever holds the UltraCamp
account) should get answers to:

1. **Does UltraCamp offer an API, and how does it authenticate?** For example
   API keys, OAuth, or IP allow-listing. Is API access part of the current plan,
   or extra?
2. **What can it read and write?** People, registrations, custom questions,
   health forms, medication logs, and uploaded documents, in each direction.
3. **How are people matched?** Does UltraCamp keep an ID we could store, or is
   matching by name, birth date, and parent email?
4. **Is there a bulk import and export** (CSV or spreadsheet) if the API can't
   carry health data?
5. **Security terms.**
   - How does UltraCamp protect health data, and where is it hosted?
   - Will it sign a data-protection agreement?
   - How does it notify customers of a breach?
6. **Parent consent.** Does UltraCamp collect consent for sharing health records
   between the conference and the camp? Does the conference need its own?
7. **Which direction is the source of truth?** If a parent updates a medication
   in UltraCamp during camp, does that come back to the club roster?

### Transfer options, from least to most risk

| Option | How it works | When to choose it |
| --- | --- | --- |
| **1. No transfer; parents fill in UltraCamp directly** | Camp health forms stay in UltraCamp | Until the other options are ready; zero new exposure |
| **2. Manual export, audited** (recommended first step) | The Youth Director exports a camp-ready file for the campers going, and uploads it to UltraCamp by hand. The export is audited and never emailed. | Once health records exist here and UltraCamp's import format is known |
| **3. One-way API push** | The platform sends records to UltraCamp for registered campers | Once the API, matching, and security terms are confirmed |
| **4. Two-way sync** | Changes flow both ways | Only if there's a clear need; conflict rules must be decided |

Keep the transfer in an **adapter** (`modules/…/ultracamp-adapter.ts`), as
AGENTS.md requires for external systems. That way the API details stay in one
place and can change without touching the roster.

## 6. Decisions needed before anything is built

1. **Scope.** Which of health fields, insurance, and uploaded documents are
   wanted in the first version? Could insurance card images wait?
2. **Record classes.** Confirm the field list: conditions, allergies,
   medications, dietary restrictions tied to safety, insurance, and emergency
   notes. Say which are free text and which are choices.
3. **Documents.** Choose option A, B, or C (§2).
4. **Who sees what.** Confirm or change the table in §2. In particular:
   - Can Registrars enter health data?
   - Does the Youth Director get access to all clubs, or only campers?
   - Who counts as event medical staff?
5. **Who enters the data.** Directors typing it from paper forms, or parents
   entering it themselves (which needs guardian accounts, #125–#132)? Is
   guardian consent recorded, and how?
6. **Break-glass.** Who may use it, and who reviews it each month.
7. **Retention.** Option 1, 2, or 3 (§3), how long backups are kept, and the
   legal-hold owner.
8. **Breach response.** Who decides whether a breach happened, who notifies
   families, and who contacts counsel.
9. **UltraCamp.** Answers to the questions in §5, and which transfer option to
   start with.
10. **Prerequisites (not decisions, but blocking).** Server checklist items 1–8
    done, including the key backup and its test restore. An Addendum B to
    ADR 0005 recorded and signed off.

When these are answered, the build can be split into issues:
- fields and flags;
- the Health tab and permission;
- documents;
- audit and review screens;
- the annual re-confirmation;
- the UltraCamp export.

Each part would be built with synthetic data and stay switched off until the
prerequisites are met.
