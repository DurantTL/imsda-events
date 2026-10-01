import "server-only";

import { createCensusGeocodingProvider } from "@/integrations/geocoding/census";
import { createFakeGeocodingProvider } from "@/integrations/geocoding/fake";
import type { GeocodingProvider } from "@/integrations/geocoding/types";
import { getServerEnv } from "@/lib/env";

/** Anything other than the exact value "true" is off, and so is an environment that fails to load. */
export function geocodingEnabled() {
  try {
    return getServerEnv().GEOCODING_ENABLED === true;
  } catch {
    return false;
  }
}

/** The configured provider: the Census Bureau geocoder unless `GEOCODING_PROVIDER=fake` (local work only). */
export function getGeocodingProvider(): GeocodingProvider {
  return getServerEnv().GEOCODING_PROVIDER === "fake" ? createFakeGeocodingProvider() : createCensusGeocodingProvider();
}
