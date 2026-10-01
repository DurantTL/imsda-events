/**
 * The geocoding boundary (#724). A provider turns public street addresses into
 * map points. Callers pass only a church's public street address, city, state
 * and ZIP, keyed by an opaque id; nothing else about the church leaves the
 * server. Providers never write to the database.
 */

export type GeocodeRequest = {
  /** Opaque key echoed back on the outcome (the organization id). */
  id: string;
  street: string;
  city: string;
  state: string;
  zip: string;
};

export type GeocodeOutcome =
  | { id: string; status: "MATCHED"; latitude: number; longitude: number; matchedAddress: string }
  | { id: string; status: "NO_MATCH" };

export interface GeocodingProvider {
  /** Stored with each result, e.g. "census". */
  readonly name: string;
  /**
   * One outcome per request. Throws GeocodingUnavailableError, having
   * returned nothing, when the service cannot be reached or answers badly:
   * a partial answer is never returned.
   */
  geocode(requests: GeocodeRequest[]): Promise<GeocodeOutcome[]>;
}

/** No network, a timeout, or an unusable answer. The message is safe to show staff. */
export class GeocodingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeocodingUnavailableError";
  }
}
