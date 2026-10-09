# Health records: breach response plan

Status: **Proposed**, for sign-off with ADR 0005 Addendum B (#389). Decided by
the Communication Director on 2026-10-09: the plan names the conference
president, the executive secretary, the treasurer and the system
administrators.

This plan covers club member health records (#611), meaning the encrypted health
fields, insurance details and emergency contacts. It also covers the other
protected records in ADR 0005: birth dates and Sterling Volunteers data.

## Who does what

| Role | Responsibility |
| --- | --- |
| **Communication Director** (incident lead) | Opens the incident, keeps the timeline, drafts every notice, and is the single point of contact for families and clubs. |
| **Conference president** | Decides, with the incident lead and the executive secretary, whether a breach happened. Approves every notice to families and any public statement. |
| **Executive secretary** | Contacts conference legal counsel, keeps the official record of decisions, and informs affected club directors and pastors. |
| **Treasurer** | Notifies the conference's insurance carrier, approves costs (notices, any credit monitoring for insurance details, outside help), and keeps the expense record. |
| **System administrators** | Contain the problem: disable accounts, revoke sessions, rotate keys and passwords, take the app offline if needed. They preserve the audit log and server logs, and report what was accessed. The key custodian (Addendum A) handles any key rotation. |

Fill in phone numbers and a backup person for each role in the System readiness
page (#870) or the server runbook. Keep them out of GitHub.

## What counts as a possible breach

Report any of these straight away. Don't wait to be sure.

- Someone saw or downloaded health records they shouldn't have, whether a
  person outside the club, a wrong club, or an unexplained break-glass use.
- A staff or director account was used by someone else, or a password or
  two-step device was lost or shared.
- The server, a backup copy, or the encryption key was exposed, copied or lost.
- A health export, printout or screenshot was sent or left somewhere it shouldn't be.
- The monthly access review finds access nobody can explain.

## Steps

**1. Report (immediately).** Whoever notices tells the incident lead and a
system administrator. Write down what was seen and when. Don't delete anything.

**2. Contain (first hours).** System administrators stop further access:
- disable the affected accounts and end their sessions;
- reset passwords;
- rotate any exposed secret;
- take the app offline if the cause is unknown and records may still be exposed.

They save a copy of the audit log and server logs before anything is changed
further.

**3. Assess (within 2 days).** The system administrators report:
- what was reached, read from the audit log (every health record view and
  export is logged);
- whose records, using record IDs and counts, not names, in anything written
  down outside the system;
- for how long.

The incident lead, the president and the executive secretary decide whether
it is a breach. The executive secretary brings in legal counsel, who confirms
any legal notice duties and deadlines for Iowa and Missouri residents.

**4. Notify.**
- **Families:** the incident lead drafts the notice and the president approves
  it. The executive secretary informs the affected club directors and pastors
  before or with the family notice.
- **Insurance carrier:** the treasurer notifies it.
- **Regulators:** counsel decides whether any regulator must be notified.

A notice says, in plain words:
- what happened;
- what information was involved;
- what the conference has done;
- what families can do;
- who to contact.

**5. Recover and review (within 30 days).** System administrators fix the
cause. The incident lead writes a short review: the timeline, the cause, what
changed, and whether this plan needs updating. The executive secretary files it
with the decision record.

## Related rules

- **Break-glass access** (decided 2026-10-09):
  - only system administrators may use it;
  - they must type a reason;
  - access lasts 24 hours and is logged;
  - the incident lead reviews every use each month.
- **Retention** (decided 2026-10-09): see Addendum B. Health records are
  removed when not re-confirmed, so there is less to lose.
- **Backups and the encryption key:** #875 (nightly backups to Cloudflare R2)
  and #876 (the key is kept out of the env file, with a separate tested backup).
