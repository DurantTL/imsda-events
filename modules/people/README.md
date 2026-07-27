# People module

Owns permanent people, households, household membership, and future
organization affiliations. Stable person and organization provider keys live
in the shared `ExternalIdentity` model; the church/club directory is owned by
`modules/organizations`.

Event-specific answers belong to registration or attendee snapshots rather
than overwriting identity history.
