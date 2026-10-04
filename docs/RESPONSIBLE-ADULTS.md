# Responsible adults (#131, narrow slice)

Records, for each minor on an individual registration, which adult on the same registration is
responsible for them. Man Camp needs it: fathers register with their sons, and lodging puts a
minor with the adult who is responsible for them and sends a minor with no adult to manual review
(#198 to #200). This slice only provides the recorded link that lodging and check-in will read.

It is the narrow first slice Caleb decided on Oct 4, 2026 (comment on #131). Waiver acceptance on a
minor's behalf (the consent slice), custody restrictions, pickup and release (#96), and lodging
assignment itself are out of scope.

## The rule: declared, never inferred

Authority exists only where the registrant declared it and the declaration is recorded
(`GuardianAuthority`). These never create one, alone or together:

- household membership (`HouseholdMember`), including `canManage`;
- a shared surname;
- a shared email;
- being the account holder on the registration.

The account holder appears in exactly one place: it picks which adult the form **preselects**. The
registrant still has to submit, and that submission is the declaration. The server never fills in a
missing choice.

## Who is a minor

A person is a minor when their age on the event's **start date** (in the event's time zone) is
below the event's age of majority (`Event.ageOfMajority`, default 18, 13 to 25). Someone who turns
18 on day two of the event is a minor for that event.

Age comes from a birth date answer (`date_of_birth`, `birth_date`, `birthdate`, `dob`), else the
age already worked out for the event date, else an age answer (`attendee_age`, `age`,
`guest_age`). **An unknown age is not an adult** and is flagged for staff; the form does not ask
about them and they cannot be chosen as the responsible adult. An attendee type such as "Child" or a
label never decides it.

Man Camp and the other public forms ask for an age, not a birth date, so on those events the stated
age is what is used.

## On the registration form

When a registration has at least one minor, the review step shows a required **Responsible adult**
choice for each minor: the adults on that registration plus "None of us". The preselection:

1. the only adult, if there is one;
2. otherwise the account holder, if they are an adult on the registration;
3. otherwise the first adult listed;
4. "None of us" when the registration has no adult.

The choice can be changed but never left blank. The server decides who is a minor from the
submitted answers (not from the browser) and refuses a minor with no choice, an adult who is not on
the same registration, another minor, a person of unknown age, or the minor themself. Nothing is
shown, asked or recorded when nobody is a minor, so events without minors are unchanged.

The registrant can change the choice afterwards on their private registration page (the manage
link): same checks, and it supersedes their earlier choice. A minor whose record staff set or
revoked, or that another registration holds, is shown as locked and is not changed from there.

Club and group registrations are not asked. Their rosters come from the club or the group contact,
with their own adults and youth, so asking per minor would not fit; the club flow is unchanged.
Staff can still set a responsible adult for any minor on an individual registration.

## The record

`GuardianAuthority` is append-only evidence: event, registration, minor, adult (empty for "None of
us"), source (`REGISTRATION_FORM` or `STAFF`), when, who (the registrant's person, or the staff
user), and state `ACTIVE`, `REVOKED` or `SUPERSEDED`. In the database:

- one `ACTIVE` row per (event, minor), enforced by a partial unique index, even under parallel
  writes;
- a trigger refuses every edit and delete except `ACTIVE` to `SUPERSEDED` (with a pointer to the
  new row) and `ACTIVE` to `REVOKED` (when, by whom, and a required reason), and refuses an adult who
  is not on the registration (for staff: not registered for the event). Foreign-key actions still
  work: deleting a user clears only the actor, deleting the event removes the rows;
- a staff declaration must name an adult and carry a reason.

History is never lost: changing the adult supersedes the earlier row, and revoking keeps it with who
and why. Revoking takes effect at once because only `ACTIVE` rows count as the current adult.

## Staff review

People, then Registrations, then Actions, then Responsible adults
(`/people/responsible-adults`). Needs `VIEW_SENSITIVE_DATA` to open it (it shows attendee names);
changing anything needs `MANAGE_REGISTRATION`, checked again by the endpoint
(`POST /api/events/{eventId}/guardian-authority`). It lists, with nothing silently blocked:

| Item | Meaning |
| --- | --- |
| None of us | The registrant chose "None of us" |
| No adult on the registration | A minor on a registration with no adult, and no staff-set adult |
| Age unknown | Not treated as an adult; confirm whether a responsible adult is needed |
| No responsible adult recorded | A minor with no declaration (for example a registration made before this feature) |
| Responsible adult left the registration | The chosen adult is no longer on the registration |
| Two adults claim this minor | A second adult from a different registration claimed an already-claimed minor |

The second adult's claim never replaces the first. It becomes a review item (`GuardianAuthorityConflict`)
and neither adult is blocked. Staff can keep the current adult and close the claim, or set the other
adult, which resolves it. A registrant cannot undo a staff decision or revocation: a new claim after
one is also a review item.

Staff can set or change (supersede) the responsible adult, naming an adult registered anywhere on the
event, and revoke it. Every change needs a reason, and every action is audited with ids only (never
the reason text or a name).

## Where it shows

- The Registrations screen (People) shows "Responsible adult" beside each minor.
- `GET /api/events/{eventId}/exports/responsible-adults` (`VIEW_REPORTS` and attendee-name access)
  downloads one row per minor with their responsible adult, for lodging and check-in. Every cell goes
  through the shared CSV writer, so a name starting with `=`, `+`, `-` or `@` cannot run as a
  spreadsheet formula.

## No access is granted

A responsible adult gets **no** access to the minor's medical or health records, incident history, or
any other registration or event data through this slice. No permission, role or access decision reads
the declaration; a test fails if one starts to. The only things it feeds are the lists above.

## Checks

- `npm run test:guardian-authority` (real database; also runs in CI): the declaration, the refusals,
  the five no-inference cases, the database constraints and trigger, minor status at the start date,
  two-adult conflicts, staff scoping, revocation, and audit rows holding ids only.
- `tests/guardian-authority-*.test.ts`, `tests/responsible-adult-choice.test.ts`: the rules, the
  service against an in-memory stand-in that refuses to read households or account links, the routes
  and permissions, the form control, and the no-access checks.

## Not yet

- A staff control for the age of majority. The setting exists (`Event.ageOfMajority`, default 18) and
  the event settings API accepts `ageOfMajority`, but the settings screen has no field for it.
- Lodging and check-in reading the link (#198 to #200).
- Waiver acceptance on a minor's behalf, custody restrictions and pickup (#96).
