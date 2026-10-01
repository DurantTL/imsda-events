import { getServerEnv } from "@/lib/env";
import { HEALTH_NOT_FOUND_MESSAGE, HealthRecordError } from "@/modules/health-records/errors";

/**
 * The one switch for the Pathfinder Health Record (#611). Anything other than
 * the exact value "true" is off, and so is an environment that fails to load.
 * Every route, page, tab and write checks it on the server, so with it off
 * there is nothing to reach and nothing is stored.
 */
export function healthRecordsEnabled() {
  try {
    return getServerEnv().HEALTH_RECORDS_ENABLED === true;
  } catch {
    return false;
  }
}

/** A switched-off surface answers exactly like one that does not exist. */
export function requireHealthRecordsEnabled() {
  if (!healthRecordsEnabled()) throw new HealthRecordError("NOT_FOUND", HEALTH_NOT_FOUND_MESSAGE);
}
