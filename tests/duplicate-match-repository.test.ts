import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import {
  dismissMatchCandidate,
  deferMatchCandidate,
  generateMatchCandidates,
  PersonMatchCandidateError,
} from "@/modules/people/duplicate-match-repository";

type PersonRow = { id: string; firstName: string; lastName: string; normalizedEmail: string | null; phone: string | null };
type HouseholdMemberRow = { personId: string; householdId: string; effectiveTo: Date | null };
type ExternalIdentityRow = { personId: string | null; provider: string; providerScope: string; externalId: string };
type CandidateRow = {
  id: string;
  personAId: string;
  personBId: string;
  matchedSignals: string[];
  contradictingSignals: string[];
  confidence: string;
  ruleVersion: number;
  state: string;
  fingerprint: string;
  computedAt: Date;
  dismissedAt: Date | null;
  dismissedByUserId: string | null;
  dismissalReason: string | null;
  personA?: PersonRow;
  personB?: PersonRow;
};

function buildFakePrisma(fixture: {
  people?: PersonRow[];
  householdMembers?: HouseholdMemberRow[];
  externalIdentities?: ExternalIdentityRow[];
  candidates?: CandidateRow[];
}) {
  const people = fixture.people ?? [];
  const householdMembers = fixture.householdMembers ?? [];
  const externalIdentities = fixture.externalIdentities ?? [];
  const candidates: CandidateRow[] = fixture.candidates ?? [];
  let nextId = 1;

  const personById = new Map(people.map((person) => [person.id, person]));

  const personMatchCandidate = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; personAId_personBId_fingerprint?: { personAId: string; personBId: string; fingerprint: string } } }) => {
      if (where.id) {
        const found = candidates.find((row) => row.id === where.id);
        return found ? { ...found } : null;
      }
      const key = where.personAId_personBId_fingerprint!;
      const found = candidates.find(
        (row) => row.personAId === key.personAId && row.personBId === key.personBId && row.fingerprint === key.fingerprint,
      );
      return found ? { ...found } : null;
    }),
    findFirst: vi.fn(async ({ where }: { where: { personAId: string; personBId: string; state: string } }) => {
      const found = candidates.find(
        (row) => row.personAId === where.personAId && row.personBId === where.personBId && row.state === where.state,
      );
      return found ? { ...found } : null;
    }),
    create: vi.fn(async ({ data }: { data: Omit<CandidateRow, "id" | "state" | "computedAt" | "dismissedAt" | "dismissedByUserId" | "dismissalReason"> }) => {
      const row: CandidateRow = {
        id: `cand_${nextId++}`,
        state: "OPEN",
        computedAt: new Date(),
        dismissedAt: null,
        dismissedByUserId: null,
        dismissalReason: null,
        ...data,
      };
      candidates.push(row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<CandidateRow> }) => {
      const row = candidates.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return { ...row };
    }),
    findMany: vi.fn(async ({ where }: { where?: Partial<Pick<CandidateRow, "state" | "personAId" | "personBId">> } = {}) => {
      return candidates
        .filter((row) => {
          if (where?.state && row.state !== where.state) return false;
          if (where?.personAId && row.personAId !== where.personAId) return false;
          if (where?.personBId && row.personBId !== where.personBId) return false;
          return true;
        })
        .map((row) => ({
          ...row,
          personA: personById.get(row.personAId),
          personB: personById.get(row.personBId),
        }));
    }),
  };

  const prisma = {
    person: { findMany: vi.fn(async () => people) },
    householdMember: {
      findMany: vi.fn(async ({ where }: { where?: { effectiveTo?: null } } = {}) =>
        where?.effectiveTo === null ? householdMembers.filter((row) => row.effectiveTo === null) : householdMembers,
      ),
    },
    externalIdentity: {
      findMany: vi.fn(async () => externalIdentities.filter((row) => row.personId !== null)),
    },
    personMatchCandidate,
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma)),
  };
  return prisma;
}

beforeEach(() => vi.clearAllMocks());

function person(overrides: Partial<PersonRow> & { id: string }): PersonRow {
  return { firstName: "First", lastName: "Last", normalizedEmail: null, phone: null, ...overrides };
}

describe("generateMatchCandidates", () => {
  it("surfaces a candidate for two people sharing a normalized email", async () => {
    const prisma = buildFakePrisma({
      people: [
        person({ id: "per_a", normalizedEmail: "shared@example.org" }),
        person({ id: "per_b", firstName: "Other", lastName: "Person", normalizedEmail: "shared@example.org" }),
      ],
    });
    mocks.getPrisma.mockReturnValue(prisma);

    const result = await generateMatchCandidates();
    expect(result.created).toBe(1);
    expect(prisma.personMatchCandidate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ personAId: "per_a", personBId: "per_b", confidence: "HIGH" }),
      }),
    );
  });

  it("surfaces a candidate for two people sharing an external identity", async () => {
    const prisma = buildFakePrisma({
      people: [
        person({ id: "per_a", firstName: "Alex", lastName: "One" }),
        person({ id: "per_b", firstName: "Sam", lastName: "Two" }),
      ],
      externalIdentities: [
        { personId: "per_a", provider: "EADVENTIST", providerScope: "", externalId: "ea-999" },
        { personId: "per_b", provider: "EADVENTIST", providerScope: "", externalId: "ea-999" },
      ],
    });
    mocks.getPrisma.mockReturnValue(prisma);

    const result = await generateMatchCandidates();
    expect(result.created).toBe(1);
    expect(prisma.personMatchCandidate.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ confidence: "HIGH" }) }),
    );
  });

  it("does not surface two different people who only share a full name", async () => {
    const prisma = buildFakePrisma({
      people: [
        person({ id: "per_a", firstName: "Chris", lastName: "Johnson", normalizedEmail: "chris.one@example.org" }),
        person({ id: "per_b", firstName: "Chris", lastName: "Johnson", normalizedEmail: "chris.two@example.org" }),
      ],
    });
    mocks.getPrisma.mockReturnValue(prisma);

    const result = await generateMatchCandidates();
    expect(result.created).toBe(0);
    expect(result.evaluated).toBe(0);
  });

  it("surfaces twins who share a household and surname", async () => {
    const prisma = buildFakePrisma({
      people: [
        person({ id: "per_a", firstName: "Ann", lastName: "Twinner" }),
        person({ id: "per_b", firstName: "Beth", lastName: "Twinner" }),
      ],
      householdMembers: [
        { personId: "per_a", householdId: "hh_1", effectiveTo: null },
        { personId: "per_b", householdId: "hh_1", effectiveTo: null },
      ],
    });
    mocks.getPrisma.mockReturnValue(prisma);

    const result = await generateMatchCandidates();
    expect(result.created).toBe(1);
    expect(prisma.personMatchCandidate.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ confidence: "MEDIUM" }) }),
    );
  });

  it("is idempotent: a rerun over unchanged data creates nothing new", async () => {
    const prisma = buildFakePrisma({
      people: [
        person({ id: "per_a", normalizedEmail: "shared@example.org" }),
        person({ id: "per_b", firstName: "Other", lastName: "Person", normalizedEmail: "shared@example.org" }),
      ],
    });
    mocks.getPrisma.mockReturnValue(prisma);

    const first = await generateMatchCandidates();
    expect(first.created).toBe(1);

    const second = await generateMatchCandidates();
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(prisma.personMatchCandidate.create).toHaveBeenCalledTimes(1);
  });

  it("does not regenerate a dismissed pair whose data has not changed", async () => {
    const prisma = buildFakePrisma({
      people: [
        person({ id: "per_a", normalizedEmail: "shared@example.org" }),
        person({ id: "per_b", firstName: "Other", lastName: "Person", normalizedEmail: "shared@example.org" }),
      ],
    });
    mocks.getPrisma.mockReturnValue(prisma);

    await generateMatchCandidates();
    const [created] = prisma.personMatchCandidate.create.mock.results.map((entry) => entry.value);
    const row = await created;
    await dismissMatchCandidate(row.id, "user_staff", "Confirmed two different households.");

    const rerun = await generateMatchCandidates();
    expect(rerun.created).toBe(0);
    expect(rerun.unchanged).toBe(1);

    const open = await prisma.personMatchCandidate.findFirst({ where: { personAId: "per_a", personBId: "per_b", state: "OPEN" } });
    expect(open).toBeNull();
  });

  it("regenerates a dismissed pair once the underlying data changes", async () => {
    const people = [
      person({ id: "per_a", normalizedEmail: "shared@example.org" }),
      person({ id: "per_b", firstName: "Other", lastName: "Person", normalizedEmail: "shared@example.org" }),
    ];
    const prisma = buildFakePrisma({ people });
    mocks.getPrisma.mockReturnValue(prisma);

    await generateMatchCandidates();
    const firstRow = await prisma.personMatchCandidate.findFirst({ where: { personAId: "per_a", personBId: "per_b", state: "OPEN" } });
    await dismissMatchCandidate(firstRow!.id, "user_staff", "Confirmed two different households.");

    // The underlying data changes: person B's phone now also matches.
    people[0].phone = "5551234567";
    people[1].phone = "5551234567";

    const rerun = await generateMatchCandidates();
    expect(rerun.created).toBe(1);

    const open = await prisma.personMatchCandidate.findFirst({ where: { personAId: "per_a", personBId: "per_b", state: "OPEN" } });
    expect(open).not.toBeNull();
  });

  it("supersedes the previous open candidate instead of creating a second open row for the same pair", async () => {
    const people = [
      person({ id: "per_a", normalizedEmail: "shared@example.org" }),
      person({ id: "per_b", firstName: "Other", lastName: "Person", normalizedEmail: "shared@example.org" }),
    ];
    const prisma = buildFakePrisma({ people });
    mocks.getPrisma.mockReturnValue(prisma);

    await generateMatchCandidates();
    people[0].phone = "5551234567";
    people[1].phone = "5551234567";
    await generateMatchCandidates();

    const all = await candidatesFor(prisma, "per_a", "per_b");
    expect(all.filter((row) => row.state === "OPEN")).toHaveLength(1);
    expect(all.filter((row) => row.state === "SUPERSEDED")).toHaveLength(1);
  });

  it("running generation twice in a row never errors and never duplicates rows", async () => {
    const prisma = buildFakePrisma({
      people: [
        person({ id: "per_a", normalizedEmail: "shared@example.org" }),
        person({ id: "per_b", firstName: "Other", lastName: "Person", normalizedEmail: "shared@example.org" }),
      ],
    });
    mocks.getPrisma.mockReturnValue(prisma);

    await expect(generateMatchCandidates()).resolves.toBeDefined();
    await expect(generateMatchCandidates()).resolves.toBeDefined();
    expect(await candidatesFor(prisma, "per_a", "per_b")).toHaveLength(1);
  });
});

async function candidatesFor(prisma: ReturnType<typeof buildFakePrisma>, personAId: string, personBId: string) {
  return prisma.personMatchCandidate.findMany({ where: { personAId, personBId } }) as Promise<CandidateRow[]>;
}

describe("dismissMatchCandidate", () => {
  it("requires a reason", async () => {
    const prisma = buildFakePrisma({
      candidates: [{
        id: "cand_1", personAId: "per_a", personBId: "per_b", matchedSignals: ["EMAIL_MATCH"], contradictingSignals: [],
        confidence: "HIGH", ruleVersion: 1, state: "OPEN", fingerprint: "fp1", computedAt: new Date(),
        dismissedAt: null, dismissedByUserId: null, dismissalReason: null,
      }],
    });
    mocks.getPrisma.mockReturnValue(prisma);
    await expect(dismissMatchCandidate("cand_1", "user_1", "no")).rejects.toBeInstanceOf(PersonMatchCandidateError);
  });

  it("dismisses an open candidate and writes an audit entry", async () => {
    const prisma = buildFakePrisma({
      candidates: [{
        id: "cand_1", personAId: "per_a", personBId: "per_b", matchedSignals: ["EMAIL_MATCH"], contradictingSignals: [],
        confidence: "HIGH", ruleVersion: 1, state: "OPEN", fingerprint: "fp1", computedAt: new Date(),
        dismissedAt: null, dismissedByUserId: null, dismissalReason: null,
      }],
    });
    mocks.getPrisma.mockReturnValue(prisma);

    const updated = await dismissMatchCandidate("cand_1", "user_1", "Confirmed two different people.");
    expect(updated.state).toBe("DISMISSED");
    expect(updated.dismissedByUserId).toBe("user_1");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MATCH_CANDIDATE_DISMISSED", entityId: "cand_1" }),
      expect.anything(),
    );
  });

  it("refuses to dismiss a candidate that is not open", async () => {
    const prisma = buildFakePrisma({
      candidates: [{
        id: "cand_1", personAId: "per_a", personBId: "per_b", matchedSignals: [], contradictingSignals: [],
        confidence: "HIGH", ruleVersion: 1, state: "DISMISSED", fingerprint: "fp1", computedAt: new Date(),
        dismissedAt: new Date(), dismissedByUserId: "user_0", dismissalReason: "already dismissed",
      }],
    });
    mocks.getPrisma.mockReturnValue(prisma);
    await expect(dismissMatchCandidate("cand_1", "user_1", "another reason")).rejects.toMatchObject({ code: "NOT_OPEN" });
  });
});

describe("deferMatchCandidate", () => {
  it("leaves the candidate open and only writes an audit entry", async () => {
    const prisma = buildFakePrisma({
      candidates: [{
        id: "cand_1", personAId: "per_a", personBId: "per_b", matchedSignals: ["EMAIL_MATCH"], contradictingSignals: [],
        confidence: "HIGH", ruleVersion: 1, state: "OPEN", fingerprint: "fp1", computedAt: new Date(),
        dismissedAt: null, dismissedByUserId: null, dismissalReason: null,
      }],
    });
    mocks.getPrisma.mockReturnValue(prisma);

    const result = await deferMatchCandidate("cand_1", "user_1");
    expect(result.state).toBe("OPEN");
    expect(prisma.personMatchCandidate.update).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MATCH_CANDIDATE_DEFERRED", entityId: "cand_1" }),
    );
  });
});
