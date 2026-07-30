import "server-only";

import { getServerEnv } from "@/lib/env";

/**
 * Builds browser destinations from the deployment's canonical public origin.
 *
 * Route-handler request URLs can contain a reverse proxy's private hostname
 * and port. They are suitable for reading request parameters, but not for
 * telling a browser where to go after authentication.
 */
export function attendeePublicUrl(path: `/${string}`) {
  return new URL(path, getServerEnv().APP_BASE_URL);
}
