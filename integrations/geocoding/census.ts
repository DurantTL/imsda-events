import { GeocodingUnavailableError, type GeocodeOutcome, type GeocodeRequest, type GeocodingProvider } from "@/integrations/geocoding/types";

/**
 * The U.S. Census Bureau Geocoder (#724): free, no API key, meant for public
 * US addresses. Uses the address-batch endpoint, in chunks. Only the street,
 * city, state and ZIP of each request are sent, with the request's opaque id.
 * Production needs outbound HTTPS to geocoding.geo.census.gov.
 */

export const CENSUS_BATCH_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";
const BENCHMARK = "Public_AR_Current";
/** Well under the service's 10,000-address limit, and short enough to finish inside the timeout. */
export const CENSUS_CHUNK_SIZE = 250;
/**
 * The most time a whole lookup may take, across all chunks. It stays under a
 * typical reverse-proxy timeout (60 s) so staff see our error, not a gateway
 * one. A lookup that can't finish inside it fails and changes nothing.
 */
export const CENSUS_TOTAL_BUDGET_MS = 55_000;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** One CSV record per line; quoted fields may hold commas and doubled quotes. */
function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === "\"") {
        if (text[i + 1] === "\"") { field += "\""; i += 1; } else quoted = false;
      } else field += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { record.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      if (field !== "" || record.length > 0) { record.push(field); records.push(record); }
      record = []; field = "";
    } else field += char;
  }
  if (field !== "" || record.length > 0) { record.push(field); records.push(record); }
  return records;
}

const csvCell = (value: string) => `"${value.replace(/[\r\n]+/g, " ").replace(/"/g, "\"\"")}"`;

/** Reads the batch answer: id, input, Match|No_Match|Tie, type, matched address, "lon,lat", ... */
export function parseCensusBatchResponse(body: string, requests: GeocodeRequest[]): GeocodeOutcome[] {
  const byId = new Map<string, GeocodeOutcome>();
  for (const row of parseRecords(body)) {
    const id = row[0]?.trim();
    if (!id) continue;
    if (row[2]?.trim().toLowerCase() === "match") {
      const [lon, lat] = (row[5] ?? "").split(",").map((part) => Number(part.trim()));
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat!) <= 90 && Math.abs(lon!) <= 180) {
        byId.set(id, { id, status: "MATCHED", latitude: lat!, longitude: lon!, matchedAddress: (row[4] ?? "").trim() });
        continue;
      }
    }
    // "No_Match", "Tie" (several equally good candidates), or an unusable point.
    byId.set(id, { id, status: "NO_MATCH" });
  }
  // A request the answer skips is a bad answer, not a "no match".
  if (requests.some((request) => !byId.has(request.id))) {
    throw new GeocodingUnavailableError("The geocoding service returned an incomplete answer. Nothing was changed.");
  }
  return requests.map((request) => byId.get(request.id)!);
}

export function createCensusGeocodingProvider(
  fetchImpl: Fetch = (input, init) => fetch(input, init),
  now: () => number = () => Date.now(),
): GeocodingProvider {
  async function geocodeChunk(chunk: GeocodeRequest[], deadline: number) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new GeocodingUnavailableError("Looking up map locations took too long. Nothing was changed; try again.");
    }
    const csv = chunk.map((r) => [r.id, r.street, r.city, r.state, r.zip].map(csvCell).join(",")).join("\n");
    const form = new FormData();
    form.set("benchmark", BENCHMARK);
    form.set("addressFile", new Blob([csv], { type: "text/csv" }), "addresses.csv");
    let response: Response;
    try {
      response = await fetchImpl(CENSUS_BATCH_URL, { method: "POST", body: form, signal: AbortSignal.timeout(remaining), cache: "no-store" });
    } catch {
      throw new GeocodingUnavailableError("The map location service could not be reached. Check the server's outbound access to geocoding.geo.census.gov and try again. Nothing was changed.");
    }
    if (!response.ok) {
      throw new GeocodingUnavailableError(`The map location service answered with an error (${response.status}). Nothing was changed.`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new GeocodingUnavailableError("The map location service's answer was cut off. Nothing was changed.");
    }
    return parseCensusBatchResponse(text, chunk);
  }

  return {
    name: "census",
    async geocode(requests) {
      const outcomes: GeocodeOutcome[] = [];
      const deadline = now() + CENSUS_TOTAL_BUDGET_MS;
      for (let start = 0; start < requests.length; start += CENSUS_CHUNK_SIZE) {
        outcomes.push(...await geocodeChunk(requests.slice(start, start + CENSUS_CHUNK_SIZE), deadline));
      }
      return outcomes;
    },
  };
}
