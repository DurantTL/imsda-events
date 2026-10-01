import { GeocodingUnavailableError, type GeocodeOutcome, type GeocodeRequest, type GeocodingProvider } from "@/integrations/geocoding/types";

/**
 * An offline stand-in for the geocoder (#724). Tests use it so the real
 * service is never called; `GEOCODING_PROVIDER=fake` uses it for local work.
 * Deterministic: a street containing "Nowhere" has no match, one containing
 * "Outage" makes the whole call fail, and any other address lands at a stable
 * point inside the continental US derived from its text.
 */
export function createFakeGeocodingProvider(options: { fail?: boolean; calls?: GeocodeRequest[][] } = {}): GeocodingProvider {
  return {
    name: "fake",
    async geocode(requests) {
      options.calls?.push(requests);
      if (options.fail || requests.some((request) => /outage/i.test(request.street))) {
        throw new GeocodingUnavailableError("The map location service could not be reached. Nothing was changed.");
      }
      return requests.map((request): GeocodeOutcome => {
        if (/nowhere/i.test(request.street)) return { id: request.id, status: "NO_MATCH" };
        let hash = 0;
        for (const char of `${request.street}|${request.city}|${request.state}|${request.zip}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        return {
          id: request.id,
          status: "MATCHED",
          latitude: 30 + (hash % 1500) / 100,
          longitude: -120 + ((hash >>> 8) % 4500) / 100,
          matchedAddress: `${request.street}, ${request.city}, ${request.state} ${request.zip}`.toUpperCase(),
        };
      });
    },
  };
}
