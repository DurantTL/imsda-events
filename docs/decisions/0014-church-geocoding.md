# ADR 0014: Church map locations may be geocoded, by staff, from public addresses

Status: Accepted by the Communication Director (request of 2026-10-01, #724).
Date: 2026-10-01
Reverses: the "never geocode" rule in #437 and #480 (church locations are only typed in or placed by hand).

## Context

The public club map reads `ChurchLocation`. Staff placed each church by hand. The eAdventist
import (#649) already holds every church's street address, but nothing carried it to the map,
and the code deliberately never geocoded.

## Decision

- The eAdventist import fills `ChurchLocation` with city, state and ZIP for active churches.
  It never writes coordinates and never geocodes. Groups, companies, schools and camps get no
  location (the map plots churches; groups often meet in homes).
- A separate, staff-triggered "Find map locations" step looks up points for churches that have a
  street address and no point, through a geocoding adapter (`integrations/geocoding`). The first
  provider is the U.S. Census Bureau geocoder: free, no key, public US addresses. Only the street,
  city, state and ZIP of the church's public address are sent.
- `ChurchLocation.source` is `IMPORT`, `MANUAL` or `GEOCODED`. Existing rows are `MANUAL`.
  Neither the import nor the geocoder overwrites `MANUAL`; saving on the location page makes a
  row `MANUAL`. A geocoded match reaches the map only after a system administrator accepts it.
- The step runs only when `GEOCODING_ENABLED=true` (default off), for system administrators,
  and is audited with counts only. A network failure reports an error and changes nothing.
  Tests use a fake provider and never call the service.

## Consequences

- Production needs outbound HTTPS to `geocoding.geo.census.gov` when the flag is on.
- Church street addresses leave the server, but only on a staff click, and only public addresses.
  Home-meeting groups and town-only records are never sent.
- Running the import and the geocoding on production remains a human action.
