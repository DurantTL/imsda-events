import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  ConsentPolicyError,
  createEventPolicyApplicability,
  createNextDraftVersion,
  getPolicyVersionEffectiveAt,
  getPolicyVersionForEvidence,
  publishPolicyVersion,
  resolveApplicablePolicies,
  updateDraftPolicyVersion,
} from "@/modules/consent/repository";

// Obviously synthetic placeholder text — no real or realistic legal wording.
const placeholder = { title: "Synthetic placeholder title", bodyText: "Lorem placeholder body for automated tests only." };

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "version-1",
    policyId: "policy-1",
    versionNumber: 1,
    status: "PUBLISHED",
    ...placeholder,
    contentHash: "a".repeat(64),
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    effectiveTo: null,
    isMaterialChange: null,
    publishedAt: new Date("2025-12-20T00:00:00Z"),
    publishedBy: { id: "user-1", displayName: "Synthetic Publisher" },
    createdAt: new Date("2025-12-01T00:00:00Z"),
    updatedAt: new Date("2025-12-20T00:00:00Z"),
    policy: { id: "policy-1", kind: "CONSENT", scope: "EVENT", eventId: "event-1" },
    ...overrides,
  };
}

function client() {
  return {
    consentPolicy: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    consentPolicyVersion: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    eventAttendeeType: { findFirst: vi.fn() },
    eventConsentPolicyApplicability: { create: vi.fn(), findMany: vi.fn() },
    event: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

type Client = ReturnType<typeof client>;

function useClient(tx: Client) {
  dependencies.getPrisma.mockReturnValue({
    ...tx,
    $transaction: vi.fn(async (operation: (inner: Client) => unknown) => operation(tx)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("published consent policy versions are immutable", () => {
  it("refuses an update attempt against a published version and never writes", async () => {
    const tx = client();
    tx.consentPolicyVersion.findFirst.mockResolvedValue({ id: "version-1", status: "PUBLISHED", versionNumber: 1 });
    useClient(tx);

    await expect(
      updateDraftPolicyVersion("event-1", "policy-1", "version-1", "user-1", { title: "Synthetic edit", bodyText: "Placeholder edit." }),
    ).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
    expect(tx.consentPolicyVersion.updateMany).not.toHaveBeenCalled();
    expect(tx.consentPolicyVersion.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses when the version is published between the read and the write", async () => {
    const tx = client();
    tx.consentPolicyVersion.findFirst.mockResolvedValue({ id: "version-2", status: "DRAFT", versionNumber: 2 });
    tx.consentPolicyVersion.updateMany.mockResolvedValue({ count: 0 });
    useClient(tx);

    await expect(
      updateDraftPolicyVersion("event-1", "policy-1", "version-2", "user-1", placeholder),
    ).rejects.toBeInstanceOf(ConsentPolicyError);
    expect(tx.consentPolicyVersion.updateMany).toHaveBeenCalledWith({
      where: { id: "version-2", policyId: "policy-1", status: "DRAFT", publishedAt: null },
      data: placeholder,
    });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("edits a draft only through a write conditioned on draft status", async () => {
    const tx = client();
    tx.consentPolicyVersion.findFirst.mockResolvedValue({ id: "version-2", status: "DRAFT", versionNumber: 2 });
    tx.consentPolicyVersion.findUniqueOrThrow.mockResolvedValue(versionRow({ id: "version-2", versionNumber: 2, status: "DRAFT", publishedAt: null, contentHash: null, effectiveFrom: null, publishedBy: null }));
    useClient(tx);

    const version = await updateDraftPolicyVersion("event-1", "policy-1", "version-2", "user-1", placeholder);
    expect(version.status).toBe("DRAFT");
    expect(tx.consentPolicyVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "version-2", policy: { id: "policy-1", eventId: "event-1" } },
    }));
  });

  it("starts a correction as a new version instead of reopening a published one", async () => {
    const tx = client();
    tx.consentPolicy.findFirst.mockResolvedValue({ id: "policy-1", name: "Synthetic policy", versions: [{ versionNumber: 3, status: "PUBLISHED" }, { versionNumber: 2, status: "PUBLISHED" }] });
    tx.consentPolicyVersion.create.mockResolvedValue(versionRow({ id: "version-4", versionNumber: 4, status: "DRAFT", publishedAt: null, publishedBy: null }));
    useClient(tx);

    await createNextDraftVersion("event-1", "policy-1", "user-1", placeholder);
    expect(tx.consentPolicyVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ policyId: "policy-1", versionNumber: 4 }),
    }));
    expect(tx.consentPolicyVersion.update).not.toHaveBeenCalled();
    expect(tx.consentPolicyVersion.updateMany).not.toHaveBeenCalled();
  });

  it("allows only one open draft per policy", async () => {
    const tx = client();
    tx.consentPolicy.findFirst.mockResolvedValue({ id: "policy-1", name: "Synthetic policy", versions: [{ versionNumber: 2, status: "DRAFT" }] });
    useClient(tx);

    await expect(createNextDraftVersion("event-1", "policy-1", "user-1", placeholder)).rejects.toMatchObject({ code: "DRAFT_EXISTS" });
    expect(tx.consentPolicyVersion.create).not.toHaveBeenCalled();
  });
});

describe("publishing consent policy versions", () => {
  function policyWith(versions: Array<Record<string, unknown>>) {
    return { id: "policy-1", eventId: "event-1", name: "Synthetic policy", versions };
  }

  it("requires a human-set material-change flag for every publication", async () => {
    const tx = client();
    tx.consentPolicy.findFirst.mockResolvedValue(policyWith([{ id: "version-1", status: "DRAFT", versionNumber: 1, ...placeholder }]));
    useClient(tx);

    await expect(publishPolicyVersion("event-1", "policy-1", "user-1", { effectiveFrom: "2026-06-01T00:00:00Z" })).rejects.toBeDefined();
    expect(tx.consentPolicyVersion.updateMany).not.toHaveBeenCalled();
  });

  it("republishes without touching any previously published version", async () => {
    const tx = client();
    tx.consentPolicy.findFirst.mockResolvedValue(policyWith([
      { id: "version-1", status: "PUBLISHED", versionNumber: 1, ...placeholder },
      { id: "version-2", status: "DRAFT", versionNumber: 2, title: "Synthetic revised title", bodyText: "Revised placeholder body." },
    ]));
    tx.consentPolicyVersion.findUniqueOrThrow.mockResolvedValue(versionRow({ id: "version-2", versionNumber: 2, isMaterialChange: false }));
    useClient(tx);

    await publishPolicyVersion("event-1", "policy-1", "user-1", {
      effectiveFrom: "2026-06-01T00:00:00Z",
      isMaterialChange: false,
    });

    expect(tx.consentPolicyVersion.updateMany).toHaveBeenCalledTimes(1);
    const [call] = tx.consentPolicyVersion.updateMany.mock.calls[0]!;
    expect(call.where).toEqual({
      id: "version-2", status: "DRAFT", publishedAt: null,
      title: "Synthetic revised title", bodyText: "Revised placeholder body.",
    });
    expect(call.data).toMatchObject({
      status: "PUBLISHED",
      publishedByUserId: "user-1",
      effectiveFrom: new Date("2026-06-01T00:00:00Z"),
      effectiveTo: null,
      isMaterialChange: false,
    });
    expect(call.data.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(call.data.publishedAt).toBeInstanceOf(Date);
    expect(tx.consentPolicyVersion.update).not.toHaveBeenCalled();
    expect(tx.consentPolicy.update).toHaveBeenCalledWith({ where: { id: "policy-1" }, data: { currentVersionId: "version-2" } });
  });

  it("refuses to publish when the draft text changed after it was read", async () => {
    const tx = client();
    tx.consentPolicy.findFirst.mockResolvedValue(policyWith([
      { id: "version-1", status: "DRAFT", versionNumber: 1, ...placeholder },
    ]));
    tx.consentPolicyVersion.updateMany.mockResolvedValue({ count: 0 });
    useClient(tx);

    await expect(publishPolicyVersion("event-1", "policy-1", "user-1", {
      effectiveFrom: "2026-01-01T00:00:00Z", isMaterialChange: false,
    })).rejects.toMatchObject({ code: "NO_DRAFT" });
    expect(tx.consentPolicyVersion.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ title: placeholder.title, bodyText: placeholder.bodyText }),
    }));
    expect(tx.consentPolicy.update).not.toHaveBeenCalled();
  });

  it("publishes a first version with an explicit material-change judgment", async () => {
    const tx = client();
    tx.consentPolicy.findFirst.mockResolvedValue(policyWith([{ id: "version-1", status: "DRAFT", versionNumber: 1, ...placeholder }]));
    tx.consentPolicyVersion.findUniqueOrThrow.mockResolvedValue(versionRow());
    useClient(tx);

    await publishPolicyVersion("event-1", "policy-1", "user-1", { effectiveFrom: "2026-01-01T00:00:00Z", isMaterialChange: false });
    expect(tx.consentPolicyVersion.updateMany.mock.calls[0]![0].data.isMaterialChange).toBe(false);
  });

  it("refuses a publish when there is no draft", async () => {
    const tx = client();
    tx.consentPolicy.findFirst.mockResolvedValue(policyWith([{ id: "version-1", status: "PUBLISHED", versionNumber: 1, ...placeholder }]));
    useClient(tx);

    await expect(
      publishPolicyVersion("event-1", "policy-1", "user-1", { effectiveFrom: "2026-01-01T00:00:00Z", isMaterialChange: true }),
    ).rejects.toMatchObject({ code: "NO_DRAFT" });
  });

  it("cannot publish another event's or an organization policy through an event caller", async () => {
    const tx = client();
    tx.consentPolicy.findFirst.mockResolvedValue(null);
    useClient(tx);

    await expect(
      publishPolicyVersion("event-1", "policy-org", "user-1", { effectiveFrom: "2026-01-01T00:00:00Z", isMaterialChange: false }),
    ).rejects.toMatchObject({ code: "POLICY_NOT_FOUND" });
    expect(tx.consentPolicy.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "policy-org", eventId: "event-1" } }));
  });
});

describe("effective-at-date and evidence queries are separate", () => {
  const versionOne = versionRow({ id: "version-1", versionNumber: 1, effectiveTo: new Date("2026-06-01T00:00:00Z") });
  const versionTwo = versionRow({ id: "version-2", versionNumber: 2, effectiveFrom: new Date("2026-06-01T00:00:00Z"), isMaterialChange: true });

  it("presents the version effective at the presentation date", async () => {
    const tx = client();
    tx.consentPolicyVersion.findMany.mockResolvedValue([versionOne, versionTwo]);
    useClient(tx);

    expect((await getPolicyVersionEffectiveAt("policy-1", new Date("2026-03-01T00:00:00Z")))?.id).toBe("version-1");
    expect((await getPolicyVersionEffectiveAt("policy-1", new Date("2026-07-01T00:00:00Z")))?.id).toBe("version-2");
    expect(tx.consentPolicyVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ policyId: "policy-1", status: "PUBLISHED" }),
    }));
  });

  it("returns nothing before any version is effective", async () => {
    const tx = client();
    tx.consentPolicyVersion.findMany.mockResolvedValue([versionOne, versionTwo]);
    useClient(tx);

    expect(await getPolicyVersionEffectiveAt("policy-1", new Date("2025-06-01T00:00:00Z"))).toBeNull();
  });

  it("resolves evidence to the exact version seen, even after a correction took effect", async () => {
    const tx = client();
    tx.consentPolicyVersion.findFirst.mockResolvedValue(versionOne);
    useClient(tx);

    const seen = await getPolicyVersionForEvidence("version-1");
    expect(seen.id).toBe("version-1");
    expect(seen.bodyText).toBe(placeholder.bodyText);
    expect(tx.consentPolicyVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "version-1", status: "PUBLISHED" },
    }));
    expect(tx.consentPolicyVersion.findMany).not.toHaveBeenCalled();
  });

  it("never treats a draft as evidence", async () => {
    const tx = client();
    tx.consentPolicyVersion.findFirst.mockResolvedValue(null);
    useClient(tx);

    await expect(getPolicyVersionForEvidence("version-draft")).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
  });
});

describe("per-event policy applicability", () => {
  it("rejects a policy owned by another event", async () => {
    const tx = client();
    tx.consentPolicy.findFirst.mockResolvedValue(null);
    useClient(tx);

    await expect(createEventPolicyApplicability("event-1", "user-1", { policyId: "policy-other-event" })).rejects.toMatchObject({ code: "POLICY_NOT_FOUND" });
    expect(tx.consentPolicy.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "policy-other-event", OR: [{ eventId: "event-1" }, { eventId: null }] },
    }));
    expect(tx.eventConsentPolicyApplicability.create).not.toHaveBeenCalled();
  });

  it("rejects an attendee type from another event", async () => {
    const tx = client();
    tx.consentPolicy.findFirst.mockResolvedValue({ id: "policy-1", name: "Synthetic policy" });
    tx.eventAttendeeType.findFirst.mockResolvedValue(null);
    useClient(tx);

    await expect(createEventPolicyApplicability("event-1", "user-1", { policyId: "policy-1", attendeeTypeDefinitionId: "type-elsewhere" }))
      .rejects.toMatchObject({ code: "ATTENDEE_TYPE_NOT_FOUND" });
  });

  it("resolves applicable policies by age band on the event start date", async () => {
    const tx = client();
    tx.event.findUnique.mockResolvedValue({ startsAt: new Date("2026-07-10T00:00:00Z") });
    const policy = (id: string, kind: string) => ({ id, kind, scope: "EVENT", slug: id, name: `Synthetic ${id}`, eventId: "event-1", currentVersionId: null });
    const row = (id: string, policyId: string, kind: string, overrides: Record<string, unknown>) => ({
      id, eventId: "event-1", policyId, attendeeTypeDefinitionId: null, role: null, minimumAge: null, maximumAge: null,
      isRequired: true, isActive: true, policy: policy(policyId, kind), attendeeTypeDefinition: null, ...overrides,
    });
    tx.eventConsentPolicyApplicability.findMany.mockResolvedValue([
      row("a-minor", "policy-guardian-consent", "CONSENT", { maximumAge: 17 }),
      row("a-adult", "policy-adult-waiver", "WAIVER", { minimumAge: 18 }),
      row("a-all-optional", "policy-photo-ack", "ACKNOWLEDGMENT", { isRequired: false }),
      row("a-minor-required", "policy-photo-ack", "ACKNOWLEDGMENT", { maximumAge: 17 }),
    ]);
    useClient(tx);

    const minor = await resolveApplicablePolicies("event-1", { attendeeTypeDefinitionId: null, role: null, dateOfBirth: new Date("2010-01-01T00:00:00Z") });
    expect(minor.map((entry) => [entry.policy.id, entry.isRequired])).toEqual([
      ["policy-guardian-consent", true],
      ["policy-photo-ack", true],
    ]);

    const adult = await resolveApplicablePolicies("event-1", { attendeeTypeDefinitionId: null, role: null, dateOfBirth: new Date("1990-01-01T00:00:00Z") });
    expect(adult.map((entry) => [entry.policy.id, entry.isRequired])).toEqual([
      ["policy-adult-waiver", true],
      ["policy-photo-ack", false],
    ]);
    expect(tx.eventConsentPolicyApplicability.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { eventId: "event-1", isActive: true } }));
  });
});
