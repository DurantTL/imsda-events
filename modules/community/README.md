# Attendee community

The community is event-scoped and disabled until a communications manager
publishes its conduct agreement. Only a verified attendee account that still
matches an active submitted or confirmed registration can view or mutate it.
Staff preview never impersonates an attendee and cannot post.

Posting requires acceptance of the current conduct version. Changing the
conduct text increments that version, so every participant must accept the
revision before posting again. Discussion is intentionally one reply level deep
to keep moderation usable on phones during the retreat.

Reports are private to staff with `MANAGE_COMMUNICATIONS`. Hiding or removing a
post preserves its audit trail while replacing its body in attendee views.
Notifications are in-app only: `NONE`, replies to the participant's posts, or
all new activity. No email is sent by changing this preference.

Retention is measured from the event end. The authenticated outbox sweep also
deletes community posts after the configured number of days; database cascades
remove their replies, reports, and notifications.
