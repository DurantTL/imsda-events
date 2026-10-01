import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Find map locations" (#724). Every test uses the fake provider or a stubbed
 * fetch: the real Census service is never called, and a spy proves global
 * fetch is never reached.
 */

const mocks = vi.hoisted(() => ({
  enabled: true,
  writeAuditLog: vi.fn(),
  churches: [] as Array<Record<string, unknown>>,
  findManyWhere: undefined as unknown,
  results: new Map<string, Record<string, unknown>>(),
  locations: new Map<string, Record<string, unknown>>(),
  orgs: new Map<string, Record<string, unknown>>(),
  locked: true,
  /** Runs once, mid-lookup, to simulate another admin acting while the run is in flight. */
  duringLookup: undefined as undefined | (() => void),
  /** Makes the next conditional location write find no row, as if a hand save landed first. */
  locationWriteRaces: false,
}));

const client = {
  organization: {
    findMany: vi.fn(async ({ where }: { where: unknown }) => { mocks.findManyWhere = where; return mocks.churches; }),
    count: vi.fn(async () => mocks.churches.length),
  },
  churchGeocodeResult: {
    findMany: vi.fn(async () => [...mocks.results.entries()].map(([organizationId, row]) => ({ organizationId, decision: row.decision }))),
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown> & { organizationId: string }> }) => {
      let count = 0;
      for (const row of data) {
        if (mocks.results.has(row.organizationId)) continue;
        mocks.results.set(row.organizationId, { decision: "PENDING", ...row });
        count += 1;
      }
      return { count };
    }),
    findUnique: vi.fn(async ({ where }: { where: { organizationId: string } }) => {
      const result = mocks.results.get(where.organizationId);
      if (!result) return null;
      return { ...result, organization: { ...mocks.orgs.get(where.organizationId), churchLocation: mocks.locations.get(where.organizationId) ?? null } };
    }),
    update: vi.fn(async ({ where, data }: { where: { organizationId: string }; data: Record<string, unknown> }) => {
      mocks.results.set(where.organizationId, { ...mocks.results.get(where.organizationId), ...data });
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { organizationId: string; decision: string }; data: Record<string, unknown> }) => {
      const result = mocks.results.get(where.organizationId);
      if (!result || result.decision !== where.decision) return { count: 0 };
      mocks.results.set(where.organizationId, { ...result, ...data });
      return { count: 1 };
    }),
  },
  churchLocation: {
    updateMany: vi.fn(async ({ where, data }: { where: { organizationId: string; source: { not: string } }; data: Record<string, unknown> }) => {
      const existing = mocks.locations.get(where.organizationId);
      if (mocks.locationWriteRaces || !existing || existing.source === where.source.not) return { count: 0 };
      mocks.locations.set(where.organizationId, { ...existing, ...data });
      return { count: 1 };
    }),
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown> & { organizationId: string }> }) => {
      if (mocks.locationWriteRaces || mocks.locations.has(data[0]!.organizationId)) return { count: 0 };
      mocks.locations.set(data[0]!.organizationId, data[0]!);
      return { count: 1 };
    }),
  },
  $queryRaw: vi.fn(async () => [{ locked: mocks.locked }]),
  $transaction: async (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/integrations/geocoding", () => ({
  geocodingEnabled: () => mocks.enabled,
  getGeocodingProvider: () => { throw new Error("The real provider must never be built in a test."); },
}));

import { createCensusGeocodingProvider, parseCensusBatchResponse, CENSUS_CHUNK_SIZE, CENSUS_TOTAL_BUDGET_MS } from "@/integrations/geocoding/census";
import { createFakeGeocodingProvider } from "@/integrations/geocoding/fake";
import { GeocodingUnavailableError } from "@/integrations/geocoding/types";
import { acceptGeocodeResult, runChurchGeocoding, skipGeocodeResult } from "@/modules/organizations/church-geocoding";
import { validateServerEnv } from "@/lib/env";

const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Tests must never reach the network."); });

const church = (id: string, street = `${id} Sample Road`) => ({ id, streetAddress: street, city: "Sample Hills", state: "ZZ", postalCode: "00001" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = true;
  mocks.churches = [];
  mocks.results.clear();
  mocks.locations.clear();
  mocks.orgs.clear();
  mocks.locked = true;
  mocks.duringLookup = undefined;
  mocks.locationWriteRaces = false;
  fetchSpy.mockClear();
});

describe("selecting churches to look up", () => {
  it("asks only for active churches with a street address, a town, and no hand-set or already-placed location", async () => {
    mocks.churches = [church("c1")];
    await runChurchGeocoding("admin-1", createFakeGeocodingProvider());
    const where = JSON.stringify(mocks.findManyWhere);
    expect(mocks.findManyWhere).toMatchObject({ type: "CHURCH", isActive: true, streetAddress: { not: null }, city: { not: null } });
    expect(where).toContain("\"source\":{\"not\":\"MANUAL\"}");
    expect(where).toContain("\"latitude\":null");
    // Never groups: only the CHURCH type is selected.
    expect(where).not.toContain("GROUP");
  });

  it("sends only the public address fields, keyed by the organization id", async () => {
    mocks.churches = [church("c1"), { ...church("c2"), postalCode: "000019999" }];
    const calls: Parameters<ReturnType<typeof createFakeGeocodingProvider>["geocode"]>[0][] = [];
    await runChurchGeocoding("admin-1", createFakeGeocodingProvider({ calls }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      { id: "c1", street: "c1 Sample Road", city: "Sample Hills", state: "ZZ", zip: "00001" },
      { id: "c2", street: "c2 Sample Road", city: "Sample Hills", state: "ZZ", zip: "00001-9999" },
    ]);
  });

  it("skips a church whose street is blank", async () => {
    mocks.churches = [church("c1", "  ")];
    const calls: unknown[] = [];
    const summary = await runChurchGeocoding("admin-1", createFakeGeocodingProvider({ calls: calls as never }));
    expect(summary).toEqual({ processed: 0, matched: 0, noMatch: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("running the lookup", () => {
  it("stores a result for every church and audits counts only", async () => {
    mocks.churches = [church("c1"), church("c2", "5 Nowhere Lane")];
    const summary = await runChurchGeocoding("admin-1", createFakeGeocodingProvider());
    expect(summary).toEqual({ processed: 2, matched: 1, noMatch: 1 });
    expect(mocks.results.get("c1")).toMatchObject({ status: "MATCHED", provider: "fake" });
    expect(mocks.results.get("c1")!.latitude).toEqual(expect.any(Number));
    expect(mocks.results.get("c2")).toMatchObject({ status: "NO_MATCH", latitude: null, longitude: null });
    // Nothing reaches a church location until a match is accepted.
    expect(mocks.locations.size).toBe(0);
    const entry = mocks.writeAuditLog.mock.calls[0]![0];
    expect(entry).toMatchObject({ action: "CHURCH_GEOCODING_RUN", metadata: { processed: 2, matched: 1, noMatch: 1 } });
    expect(JSON.stringify(entry)).not.toContain("Sample Road");
    expect(JSON.stringify(entry)).not.toContain("Sample Hills");
  });

  it("changes nothing and says so when the service can't be reached", async () => {
    mocks.churches = [church("c1")];
    await expect(runChurchGeocoding("admin-1", createFakeGeocodingProvider({ fail: true })))
      .rejects.toMatchObject({ code: "GEOCODING_UNAVAILABLE", message: expect.stringContaining("Nothing was changed") });
    expect(mocks.results.size).toBe(0);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("does nothing, and never queries or sends, while GEOCODING_ENABLED is off", async () => {
    mocks.enabled = false;
    mocks.churches = [church("c1")];
    const calls: unknown[] = [];
    await expect(runChurchGeocoding("admin-1", createFakeGeocodingProvider({ calls: calls as never }))).rejects.toMatchObject({ code: "GEOCODING_DISABLED" });
    expect(calls).toHaveLength(0);
    expect(client.organization.findMany).not.toHaveBeenCalled();
    expect(mocks.results.size).toBe(0);
  });

  it("resets a skipped or old result to pending when a church is looked up again", async () => {
    mocks.results.set("c1", { status: "NO_MATCH", decision: "PENDING", latitude: null, longitude: null });
    mocks.churches = [church("c1")];
    await runChurchGeocoding("admin-1", createFakeGeocodingProvider());
    expect(mocks.results.get("c1")).toMatchObject({ status: "MATCHED", decision: "PENDING" });
  });
});

describe("reviewing results", () => {
  const matched = (id: string) => {
    mocks.results.set(id, { status: "MATCHED", decision: "PENDING", latitude: 41.5, longitude: -93.6 });
    mocks.results.set(id, { ...mocks.results.get(id), inputStreet: "10 Sample Road", inputCity: "Sample Hills", inputState: "ZZ", inputZip: "00001" });
    mocks.orgs.set(id, { type: "CHURCH", name: "Sample Hills SDA Church", isActive: true, streetAddress: "10 Sample Road", city: "Sample Hills", state: "ZZ", postalCode: "00001" });
  };

  it("accepting puts the point on the location, marked GEOCODED, and audits without coordinates", async () => {
    matched("c1");
    await acceptGeocodeResult("c1", "admin-1");
    expect(mocks.locations.get("c1")).toMatchObject({ organizationId: "c1", city: "Sample Hills", state: "ZZ", zip: "00001", latitude: 41.5, longitude: -93.6, source: "GEOCODED" });
    expect(mocks.results.get("c1")).toMatchObject({ decision: "ACCEPTED" });
    const entry = mocks.writeAuditLog.mock.calls[0]![0];
    expect(entry).toMatchObject({ action: "CHURCH_GEOCODE_ACCEPTED", metadata: { organizationId: "c1" } });
    expect(JSON.stringify(entry)).not.toContain("41.5");
  });

  it("keeps the town of an imported location and only adds the point", async () => {
    matched("c1");
    mocks.locations.set("c1", { organizationId: "c1", source: "IMPORT", city: "Imported Town", state: "ZZ", zip: "", latitude: null, longitude: null });
    await acceptGeocodeResult("c1", "admin-1");
    expect(mocks.locations.get("c1")).toMatchObject({ city: "Imported Town", latitude: 41.5, source: "GEOCODED" });
  });

  it("never overwrites a location set by hand", async () => {
    matched("c1");
    mocks.locations.set("c1", { organizationId: "c1", source: "MANUAL", city: "Typed Town", state: "ZZ", zip: "", latitude: null, longitude: null });
    await expect(acceptGeocodeResult("c1", "admin-1")).rejects.toMatchObject({ code: "LOCATION_SET_BY_HAND" });
    expect(mocks.locations.get("c1")).toMatchObject({ source: "MANUAL", latitude: null });
    expect(mocks.results.get("c1")).toMatchObject({ decision: "PENDING" });
  });

  it("refuses to accept a no-match, an already-decided result, or a missing one", async () => {
    mocks.results.set("c1", { status: "NO_MATCH", decision: "PENDING", latitude: null, longitude: null });
    mocks.orgs.set("c1", { type: "CHURCH", name: "x" });
    await expect(acceptGeocodeResult("c1", "admin-1")).rejects.toMatchObject({ code: "GEOCODE_RESULT_NOT_FOUND" });
    matched("c2");
    await acceptGeocodeResult("c2", "admin-1");
    await expect(acceptGeocodeResult("c2", "admin-1")).rejects.toMatchObject({ code: "GEOCODE_RESULT_NOT_FOUND" });
    await expect(acceptGeocodeResult("missing", "admin-1")).rejects.toMatchObject({ code: "GEOCODE_RESULT_NOT_FOUND" });
  });

  it("skipping leaves the church without a point and drops the result from review", async () => {
    matched("c1");
    await skipGeocodeResult("c1", "admin-1");
    expect(mocks.results.get("c1")).toMatchObject({ decision: "SKIPPED" });
    expect(mocks.locations.size).toBe(0);
    const entry = mocks.writeAuditLog.mock.calls[0]![0];
    expect(entry).toMatchObject({ actorUserId: "admin-1", action: "CHURCH_GEOCODE_SKIPPED", entityId: "c1", metadata: { organizationId: "c1" } });
    expect(JSON.stringify(entry)).not.toContain("Sample");
    mocks.writeAuditLog.mockClear();
    await expect(skipGeocodeResult("c1", "admin-1")).rejects.toMatchObject({ code: "GEOCODE_RESULT_NOT_FOUND" });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("stale matches, races and overlapping runs (#724 review)", () => {
  const matched = (id: string, org: Record<string, unknown> = {}) => {
    mocks.results.set(id, { status: "MATCHED", decision: "PENDING", latitude: 41.5, longitude: -93.6, inputStreet: "10 Sample Road", inputCity: "Sample Hills", inputState: "ZZ", inputZip: "00001" });
    mocks.orgs.set(id, { type: "CHURCH", name: "Sample Hills SDA Church", isActive: true, streetAddress: "10 Sample Road", city: "Sample Hills", state: "ZZ", postalCode: "00001", ...org });
  };

  it("stores the address that was sent with each result", async () => {
    mocks.churches = [church("c1")];
    await runChurchGeocoding("admin-1", createFakeGeocodingProvider());
    expect(mocks.results.get("c1")).toMatchObject({ inputStreet: "c1 Sample Road", inputCity: "Sample Hills", inputState: "ZZ", inputZip: "00001" });
  });

  it("refuses to accept after the address changed, and writes nothing", async () => {
    matched("c1", { streetAddress: "99 Other Road" });
    await expect(acceptGeocodeResult("c1", "admin-1")).rejects.toMatchObject({ code: "GEOCODE_ADDRESS_CHANGED", message: "The address changed; run Find map locations again." });
    matched("c2", { postalCode: "00002" });
    await expect(acceptGeocodeResult("c2", "admin-1")).rejects.toMatchObject({ code: "GEOCODE_ADDRESS_CHANGED" });
    expect(mocks.locations.size).toBe(0);
    expect(mocks.results.get("c1")).toMatchObject({ decision: "PENDING" });
  });

  it("ignores case and spacing differences when comparing the address", async () => {
    matched("c1", { streetAddress: "  10  sample road ", city: "SAMPLE HILLS" });
    await acceptGeocodeResult("c1", "admin-1");
    expect(mocks.locations.get("c1")).toMatchObject({ source: "GEOCODED" });
  });

  it("refuses a result from before the address was recorded", async () => {
    matched("c1");
    mocks.results.set("c1", { ...mocks.results.get("c1"), inputStreet: "", inputCity: "", inputState: "", inputZip: "" });
    await expect(acceptGeocodeResult("c1", "admin-1")).rejects.toMatchObject({ code: "GEOCODE_ADDRESS_CHANGED" });
  });

  it("refuses to accept for a church that was switched off or lost its street address", async () => {
    matched("c1", { isActive: false });
    await expect(acceptGeocodeResult("c1", "admin-1")).rejects.toMatchObject({ code: "GEOCODE_RESULT_NOT_FOUND" });
    matched("c2", { streetAddress: null });
    await expect(acceptGeocodeResult("c2", "admin-1")).rejects.toMatchObject({ code: "GEOCODE_ADDRESS_CHANGED" });
    expect(mocks.locations.size).toBe(0);
  });

  it("never overwrites a hand save that lands between the read and the write (update and create)", async () => {
    matched("c1");
    mocks.locations.set("c1", { organizationId: "c1", source: "IMPORT", city: "Sample Hills", state: "ZZ", zip: "00001", latitude: null, longitude: null });
    mocks.locationWriteRaces = true;
    await expect(acceptGeocodeResult("c1", "admin-1")).rejects.toMatchObject({ code: "LOCATION_SET_BY_HAND" });
    expect(mocks.locations.get("c1")).toMatchObject({ source: "IMPORT", latitude: null });
    matched("c2");
    await expect(acceptGeocodeResult("c2", "admin-1")).rejects.toMatchObject({ code: "LOCATION_SET_BY_HAND" });
    expect(mocks.results.get("c1")).toMatchObject({ decision: "PENDING" });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("does not reset a decision made while a run was looking up", async () => {
    mocks.results.set("c1", { status: "MATCHED", decision: "PENDING", latitude: 1, longitude: 1 });
    mocks.results.set("c2", { status: "NO_MATCH", decision: "PENDING", latitude: null, longitude: null });
    mocks.churches = [church("c1"), church("c2")];
    const inner = createFakeGeocodingProvider();
    const racing = { name: "fake", geocode: async (requests: Parameters<typeof inner.geocode>[0]) => {
      mocks.results.set("c1", { ...mocks.results.get("c1"), decision: "ACCEPTED" });
      return inner.geocode(requests);
    } };
    const summary = await runChurchGeocoding("admin-1", racing);
    expect(mocks.results.get("c1")).toMatchObject({ decision: "ACCEPTED", latitude: 1 });
    expect(mocks.results.get("c2")).toMatchObject({ status: "MATCHED", decision: "PENDING" });
    expect(summary).toMatchObject({ processed: 1, matched: 1 });
  });

  it("tells a second run that one is already running, and does nothing", async () => {
    mocks.locked = false;
    mocks.churches = [church("c1")];
    const calls: unknown[] = [];
    await expect(runChurchGeocoding("admin-1", createFakeGeocodingProvider({ calls: calls as never }))).rejects.toMatchObject({ code: "GEOCODING_ALREADY_RUNNING", message: expect.stringContaining("already running") });
    expect(calls).toHaveLength(0);
    expect(mocks.results.size).toBe(0);
  });
});

describe("the Census adapter against a stubbed fetch (#724)", () => {
  it("gives up when the whole lookup would take longer than the time cap, changing nothing", async () => {
    let clock = 0;
    const stub = vi.fn(async (_url: string, init: RequestInit) => {
      clock += 40_000;
      const file = (init.body as FormData).get("addressFile") as Blob;
      const ids = (await file.text()).split("\n").map((line) => line.split(",")[0]!.replace(/"/g, ""));
      return new Response(ids.map((id) => `"${id}","x","No_Match"`).join("\n"), { status: 200 });
    });
    const provider = createCensusGeocodingProvider(stub, () => clock);
    const many = Array.from({ length: CENSUS_CHUNK_SIZE * 3 }, (_, index) => ({ id: `c${index}`, street: "1 Sample Road", city: "Sample Hills", state: "ZZ", zip: "00001" }));
    await expect(provider.geocode(many)).rejects.toThrow(/took too long.*Nothing was changed/);
    expect(stub).toHaveBeenCalledTimes(2);
    expect(CENSUS_TOTAL_BUDGET_MS).toBeLessThanOrEqual(60_000);
  });

  const requests = [
    { id: "c1", street: "1 Sample Road", city: "Sample Hills", state: "ZZ", zip: "00001" },
    { id: "c2", street: "2 Sample Road", city: "Sample Hills", state: "ZZ", zip: "00001" },
    { id: "c3", street: "3 Sample, Road", city: "Sample Hills", state: "ZZ", zip: "00001" },
  ];
  const answer = [
    "\"c1\",\"1 Sample Road, Sample Hills, ZZ, 00001\",\"Match\",\"Exact\",\"1 SAMPLE RD, SAMPLE HILLS, ZZ, 00001\",\"-93.60,41.50\",\"1\",\"L\"",
    "\"c2\",\"2 Sample Road, Sample Hills, ZZ, 00001\",\"No_Match\"",
    "\"c3\",\"3 Sample, Road, Sample Hills, ZZ, 00001\",\"Tie\"",
  ].join("\n");

  it("parses matches, no-matches and ties, longitude first", () => {
    expect(parseCensusBatchResponse(answer, requests)).toEqual([
      { id: "c1", status: "MATCHED", latitude: 41.5, longitude: -93.6, matchedAddress: "1 SAMPLE RD, SAMPLE HILLS, ZZ, 00001" },
      { id: "c2", status: "NO_MATCH" },
      { id: "c3", status: "NO_MATCH" },
    ]);
  });

  it("treats an answer that skips a church as unusable rather than as no match", () => {
    expect(() => parseCensusBatchResponse(answer.split("\n")[0]!, requests)).toThrow(GeocodingUnavailableError);
  });

  it("posts only the address columns to the Census endpoint, in chunks", async () => {
    const stub = vi.fn(async (_url: string, init: RequestInit) => {
      const file = (init.body as FormData).get("addressFile") as Blob;
      const ids = (await file.text()).split("\n").map((line) => line.split(",")[0]!.replace(/"/g, ""));
      return new Response(ids.map((id) => `"${id}","x","No_Match"`).join("\n"), { status: 200 });
    });
    const provider = createCensusGeocodingProvider(stub);
    const many = Array.from({ length: CENSUS_CHUNK_SIZE + 1 }, (_, index) => ({ ...requests[0]!, id: `c${index}` }));
    const outcomes = await provider.geocode(many);
    expect(outcomes).toHaveLength(many.length);
    expect(stub).toHaveBeenCalledTimes(2);
    expect(stub.mock.calls[0]![0]).toBe("https://geocoding.geo.census.gov/geocoder/locations/addressbatch");
    const body = stub.mock.calls[0]![1].body as FormData;
    expect(body.get("benchmark")).toBe("Public_AR_Current");
    expect([...body.keys()].sort()).toEqual(["addressFile", "benchmark"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a clear error for a network failure, an HTTP error, and a truncated answer, returning nothing", async () => {
    const down = createCensusGeocodingProvider(async () => { throw new TypeError("fetch failed"); });
    await expect(down.geocode(requests)).rejects.toThrow(/could not be reached.*Nothing was changed/);
    const bad = createCensusGeocodingProvider(async () => new Response("no", { status: 503 }));
    await expect(bad.geocode(requests)).rejects.toThrow(/\(503\)/);
    const partial = createCensusGeocodingProvider(async () => new Response(answer.split("\n")[0]!, { status: 200 }));
    await expect(partial.geocode(requests)).rejects.toBeInstanceOf(GeocodingUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GEOCODING_ENABLED", () => {
  const base = { DATABASE_URL: "postgresql://synthetic:synthetic@localhost:5432/synthetic" };
  const flag = (value?: string) => {
    const result = validateServerEnv({ ...base, ...(value === undefined ? {} : { GEOCODING_ENABLED: value }) });
    if (!result.ok) throw new Error(result.issues.join("; "));
    return result.env.GEOCODING_ENABLED;
  };

  it("is off unless exactly true, and a bad value fails the environment", () => {
    expect(flag()).toBe(false);
    expect(flag("false")).toBe(false);
    expect(flag("true")).toBe(true);
    expect(validateServerEnv({ ...base, GEOCODING_ENABLED: "yes" }).ok).toBe(false);
  });

  it("is documented off in .env.example", () => {
    expect(readFileSync(".env.example", "utf8")).toMatch(/^GEOCODING_ENABLED=false$/m);
  });
});
