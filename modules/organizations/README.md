# Organizations module

Owns the permanent IMSDA directory of churches and clubs plus stable external
provider identities.

Current foundation:

- system-administrator-only church and club create/edit workflow;
- optional club-to-sponsoring-church hierarchy;
- safe deactivation that refuses to strand active clubs;
- eAdventist, UltraCamp, Sterling Volunteers, CMMS, and WR26 identifiers;
- provider scope support for identifiers that are only unique inside an
  account or conference;
- optimistic concurrency and audit entries for every change;
- database constraints that assign each external identity to exactly one IMSDA
  person or organization.

Names, email addresses, and phone numbers are never automatic synchronization
keys. Connector work must use `ExternalIdentity`, preview proposed changes,
surface conflicts, and preserve an audit history before applying them.

The next slice is based on the current CMMS-1 `ClubRosterYear` and
`RosterMember` concepts, but will not copy their duplicated person records.
IMSDA Events will keep one permanent `Person` and attach that person to a
club-year membership with role, member status, and rollover status. Club
program type, code, district, and locality metadata must be added before CMMS
club migration.

Later slices are versioned consent/compliance and reviewed provider
synchronization. Medical, insurance, screening, and consent values must not be
collapsed into the roster-membership row.
