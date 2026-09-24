# Server security checklist (club rosters and WR26)

The to-do list for the server work that must be finished before **real club
directors enter birth dates** (H2, #356), as required by ADR 0005 Addendum A.
Several items are also WR26 go-live items (`docs/WR26-GO-LIVE-REVIEW.md`, Block 1),
so doing them once covers both.

**How to use this sheet**

- Each item has an **owner**, a **how**, and a **proof**. It is only done when the
  proof exists.
- When an item is finished, fill in **Done** (date and initials) and add a line to
  the log at the bottom saying where the evidence is kept.
- Never paste the encryption key, passwords, server addresses, or database
  contents into this file, GitHub, or chat. Say *where* something is kept, never
  *what* it is.
- Owners marked *(fill in)* still need a name. Caleb assigns them.

## Status at a glance

| # | Item | Owner | Blocks | Done |
| --- | --- | --- | --- | --- |
| 1 | Build the external, on-premises backup server | Jonathan Swena | 2, 3, 4 | ☐ |
| 2 | Keep a copy of the encryption key, apart from the database dumps | Jonathan Swena | Real birth dates | ☐ |
| 3 | Test-restore the key copy | Jonathan Swena | Real birth dates | ☐ |
| 4 | Send nightly database backups off the host | Server operator *(fill in)* | Real birth dates, WR26 | ☐ |
| 5 | Confirm an unattended restore rehearsal passes | Server operator *(fill in)* | Real birth dates, WR26 | ☐ |
| 6 | Confirm the database is reachable only from the app | Server operator *(fill in)* | Real birth dates | ☐ |
| 7 | Confirm HTTPS end to end | Server operator *(fill in)* | Real birth dates | ☐ |
| 8 | Confirm MFA for everyone who can see club data | Caleb Durant | Real birth dates | ☐ |
| 9 | Write the key rotation procedure | Jonathan Swena | Before the first rotation | ☐ |
| 10 | Tell club directors how removal works | Caleb Durant | Director onboarding | ☐ |
| 11 | Lock down how the encryption key is reached | Jonathan Swena | Real birth dates | ☐ |

## The items

### 1. Build the external, on-premises backup server
- **Why:** it holds the encryption key copy (item 2) and can receive the
  database backups (item 4). Decided: external and on-premises, not a cloud
  service.
- **How:** a machine that does not live on the same host as the events server,
  with disk encryption, a strong login, and only the people who need it having
  access.
- **Proof:** the server exists, and the owner has written down who can log in to
  it.

### 2. Keep a copy of the encryption key, apart from the database dumps
- **Why:** birth dates are encrypted with `SECRET_ENCRYPTION_KEY`. If the key is
  lost, every birth date is lost for good. If the key sits next to the database
  dumps, anyone who takes both can read everything.
- **How:** copy the production value of `SECRET_ENCRYPTION_KEY` from the deploy
  environment onto the backup server (item 1), in a separate, access-restricted
  place from the database dumps: a different folder with different permissions
  at the very least, or offline media. Record *where* it is, never the value.
- **Proof:** the custodian confirms the copy exists and matches (compare a
  checksum, never the key itself on screen or in chat).

### 3. Test-restore the key copy
- **Why:** a backup that has never been restored is not a backup.
- **How:** on a test copy of the app (never production), start it with the key
  from the backup and confirm it can read something sealed with the production
  key, such as signing in with an existing MFA login on a restored copy of the
  database.
- **Proof:** date of the test and its result, in the log below.

### 4. Send nightly database backups off the host
- **Why:** backups already run nightly (`backup` service in
  `docker-compose.yml`), but they land on the same server as the database. They
  won't survive losing that server. (WR26 finding F5.)
- **How:** set `BACKUP_OFFSITE_COMMAND` in the server's environment so each dump
  is copied to the backup server (item 1), for example with `rsync` or `scp`
  over SSH. See `docs/DEPLOY-DOCKER.md`. The dumps are not encrypted by the
  backup script, so the destination must be encrypted and access-restricted.
- **Proof:** a dump from the last 24 hours is on the backup server.

### 5. Confirm an unattended restore rehearsal passes
- **Why:** the backup service restores into a scratch database every few runs to
  prove the dumps work.
- **How:** read the `backup` container logs for `restore-verify`. A line reading
  `RESTORE REHEARSAL FAILED` means the backups are not proven.
- **Proof:** the date of a passing rehearsal, in the log below.

### 6. Confirm the database is reachable only from the app
- **Why:** the database should never be reachable from the internet.
- **How:** in production, PostgreSQL runs inside Docker's private network, and
  `docker-compose.yml` does not publish port 5432. Confirm that the
  development override file (`docker-compose.dev.yml`) is not loaded on the
  server, and that no firewall rule opens 5432.
- **Proof:** from a computer outside the server, a connection to port 5432 on
  the server's address fails.

### 7. Confirm HTTPS end to end
- **Why:** directors sign in and view minors' details over the web.
- **How:** the reverse proxy serves the site only over HTTPS with a valid
  certificate and redirects plain HTTP. The app and database talk on the
  server's private Docker network, never over the internet.
- **Proof:** the site shows a valid certificate, and `http://` redirects to
  `https://`.

### 8. Confirm MFA for everyone who can see club data
- **Why:** full birth dates are visible only to that club's directors and system
  administrators (ADR 0005 Addendum A). Both must use MFA.
- **How:** system administrators already need MFA. H2 makes a director turn on
  MFA before the roster opens. Before launch, check that every system
  administrator account has MFA set up.
- **Proof:** the list of system administrators, each with MFA on.

### 9. Write the key rotation procedure
- **Why:** if the key is ever exposed, it must be replaced without losing data.
- **How:** a short written procedure: keep the old and new keys available, run
  the re-seal step, confirm, then retire the old key and update the backup copy
  (item 2). The engineering side of the re-seal step is built when it's first
  needed.
- **Proof:** the procedure is written and kept with the key copy.

### 10. Tell club directors how removal works
- **Why:** retention is each club's decision. Nothing is deleted automatically.
- **How:** in director onboarding, explain the difference:
  - **Deactivate** keeps the person for later years (for example, members who
    become staff).
  - **Remove** erases their birth date and personal details.
- **Proof:** the onboarding note or email is sent.

### 11. Lock down how the encryption key is reached
- **Why:** the question was whether the key should sit behind a separate login
  account or inside SSH, whichever is more secure to set, reach, rotate, and
  manage. The answer is **both, in layers**: SSH is the only way in, and a
  separate account owns the key. Today the key sits in
  `/home/u_events/.xcloud/.env` (mode 600) together with every other
  production secret (`docs/DEPLOY-DOCKER.md`). So anyone who can log in as the
  site user, or reveal environment variables in the hosting panel, can read it.
- **Recommended setup** (the custodian adapts it to the host):
  1. **Only SSH, with keys.** Log in to the server by SSH key only. Turn off
     password login. Give access only to the named people on item 1's list.
  2. **The key isn't shown in a web panel.** If the hosting panel (xCloud) can
     display environment variables, anyone with a panel login can read the
     key. Keep the key out of the panel and in the server file only, or, if the
     panel must hold it, require MFA on every panel login and limit panel access
     to the same named people.
  3. **A separate account for the master copy.** The master copy of the key
     lives on the backup server (item 2) under an account used only by the
     custodian. It is not the account that receives the database dumps
     (item 4).
  4. **The app never shows or changes the key.** There's no admin screen for
     it, on purpose. Setting and rotating it are server tasks done over SSH,
     following item 9. Nobody should ever be able to read it back through the
     app.
  5. **The daily "touch" job must keep running.** The host's 30-day cleanup
     deletes `.xcloud/.env` unless the touch job in `docs/DEPLOY-DOCKER.md`
     keeps it fresh. Losing that file loses the running copy of the key. The
     backup copy (item 2) is what makes that recoverable.
  6. **Never paste it** into chat, email, tickets, GitHub, or screenshots.
     Compare checksums, never the value.
- **What changing the key breaks:** it seals authenticator (MFA) secrets and
  club roster birth dates. If it's changed without the re-seal procedure
  (item 9), every roster birth date is lost and everyone must set up MFA again.
  Any future health records would be sealed with it too
  (`docs/HEALTH-RECORDS-OPTIONS-REPORT.md`).
- **Proof:**
  - the custodian records who has SSH and panel access to the production
    server;
  - password login is off;
  - the panel either doesn't hold the key or requires MFA;
  - the master copy's account is separate from the backup account.

## Log

| Date | Item | What was done | Evidence kept at | Initials |
| --- | --- | --- | --- | --- |
| | | | | |
