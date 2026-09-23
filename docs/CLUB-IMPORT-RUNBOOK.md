# Club import runbook (#376)

How to start this year's clubs from the old website's **Pathfinder Yearly Club
Registration** (Fluent Forms form 89), so directors begin with a roster
instead of an empty page.

Importing and sending invites are human steps. The app never imports or emails
on its own.

## Before you start

- The server checklist in `docs/SERVER-SECURITY-CHECKLIST.md` must be done
  before real directors add birth dates. Importing adds no birth dates, but
  directors will add them right after they accept.
- Account email (`ACCOUNT_EMAIL_*`) must be set up, or the Send buttons stay
  off.

## 1. Export the entries

WordPress → Fluent Forms → *Pathfinder Yearly Club Registration* → Entries →
Export → **JSON**. Keep the file on your computer only. Don't email it, post it
in an issue, or paste it into a chat. Delete it when you're done.

## 2. Import

System administration → Churches and clubs → **Import clubs**. Choose the file.

The preview shows one card per registration. For each one:

- **Club name:** starts as the church name plus "Pathfinders". Edit as needed.
- **Sponsoring church:** matched to an existing church when the names agree
  (ignoring "SDA" and "Church"). Otherwise, choose one, create it from the
  form's name, or pick None.
- **Invites:** the leader is invited as Director and the co-leader as Deputy.
  Fix emails here. An invite without a valid email is left unchecked.
- **Roster:** leader, co-leader, and other staff come in as Staff;
  Pathfinders come in as Pathfinders with their class and age. Fix names,
  add missing last names, or uncheck anyone who shouldn't be added.

Addresses, phone numbers, and the child-protection answers are never read or
stored.

Press **Import**. The results list what happened to each club:

- **Imported:** the club was created, or the registration was added to an
  existing club with the same name. People already on that year's roster are
  not added twice.
- **Already imported:** this registration was imported before. Nothing
  changed.
- **Needs a fix:** for example, a club with that name is inactive. Fix it and
  import that file again. Clubs already imported are skipped.

Imported people have **no birth date**. Their roster row says "Birth date
needed" and shows the age from the form until the director adds one.

## 3. Send invites

Churches and clubs → **Club invites**. Check the emails, then press **Send**
for one club or **Send all unsent**. Each person gets an email telling them to
sign in or create an account at `/account` with that email address, then
press **Accept**.

The email has no link that grants access. Only an account whose verified
email matches the invite can accept it, and only after you've sent it.

- Wrong address: change it (the invite goes back to *Not sent*), then send
  it again.
- Didn't arrive: press **Resend**.
- No longer needed: cancel it.

## Next year

Each club can have one imported registration per club year. Next year's
export imports as a new year's roster.
