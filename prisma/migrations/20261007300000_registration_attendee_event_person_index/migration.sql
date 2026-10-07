-- The one-team-per-person check (#809) looks up an event's attendees by person: "is anyone going on this registration
-- already on another team of the club for this event". Without this index that is a scan of the event's attendees.
CREATE INDEX "RegistrationAttendee_eventId_personId_idx" ON "RegistrationAttendee"("eventId", "personId");

-- Note on the hand-written partial unique index "ClubEventRegistration_event_team_name_key" (migration
-- 20261007100000_club_teams): Prisma's schema cannot model a partial index, and `prisma migrate diff` / `migrate dev`
-- leave an index the datamodel does not declare alone (checked: the drift check in CI reports no difference). It must
-- never be dropped or recreated by a later generated migration; if one ever appears in a generated diff, remove it.
