# New club applications (#817)

How a new club gets started in IMSDA Events. Decisions are Caleb's, recorded on issue #817 (Oct 7, 2026).

## The flow

1. **Two ways in, one queue.** Anyone can open the public page **Register a new club** (`/clubs/register`, open all year, linked from
   the club finder). A system administrator can also email a prospective director a **private link** from the queue
   (`/admin/clubs/applications`); the link opens the same form with the invited email filled in and works once (30 days).
2. **The form mirrors the paper Pathfinder Program Club Application:** sponsoring church (from the church directory, or "Other"),
   pastor, the director's name, mailing address, email, home and work phone (at least one phone), the philosophy statement and church
   agreement exactly as written on the paper form (`modules/club-applications/domain.ts`), typed signatures (pastor, head elder, church
   clerk, director), an optional list of other board members, the date (stamped by the server), and an optional PDF or image
   attachment (the signed paper page or the board minutes, 10 MB or less). Club name and type (Pathfinder or Adventurer) were kept from
   the original proposal. An application creates **nothing**: no club, invite or account.
3. **Notification.** The address in **System settings, "New club application notifications"** is emailed the club name, church and
   director name with a link, and nothing else. Blank means no notice. No address is in code.
4. **Review.** System administrators approve or decline. Area Coordinators see the queue and the attachment, view only (their
   **New clubs** tab under Clubs). Each application shows the director's **Sterling Volunteers** status (Clear, Expiring soon, Not
   in compliance, No record), matched by email to an existing person or attendee account. It is a flag, not a block. Possible duplicates
   (same name at the same church, a church that already has a club, a twin application) are flagged.
5. **Approve** (one transaction): creates the club (`Organization` type CLUB under its sponsoring church; its kind is kept in
   `sourceOrgType` as "Pathfinder Club" or "Adventurer Club") and the director's ordinary club invite (`ClubInvite`, source
   `APPLICATION`, emailed right away). The director signs in and accepts, and lands in the new club. The status claim makes a second
   approval impossible. An application whose church was typed as "Other" needs a church picked from the directory first, because every
   club has a sponsoring church. When account email isn't set up the invite waits (PENDING) on the club invites page.
6. **Decline** emails the applicant, with the reason when one was given.

## Data and privacy

- `NewClubApplication`, `NewClubApplicationInvite` (token hash only; the link is minted when the email is delivered, like club form links).
- The attachment is stored under the private asset storage root with a generated name, its type checked against its bytes, and is served
  only as a download to system administrators and Area Coordinators (`/api/admin/club-applications/[id]/attachment`).
- Audit rows hold ids only (`NEW_CLUB_APPLICATION_SUBMITTED`, `_APPROVED`, `_DECLINED`, `_INVITE_SENT`, `_INVITE_CANCELLED`, and the
  club's `ORGANIZATION_CREATED`). Names, addresses, phones, the note and the decline reason never go there.
- The public submit is same-origin only (CSRF), rate limited per client and per director email, size capped, and bot checked with a hidden
  field and a minimum fill time.

## Checks

`npm run test:new-club-application` (real database, with a local stand-in for the email provider) and the Vitest files
`tests/new-club-application-*.test.ts`.
