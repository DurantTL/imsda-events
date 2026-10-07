import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #165: the resolver, staff decisions, and billing contacts, against an in-memory stand-in for the
 * few Prisma calls the service makes. The real database constraints (one active contact, check
 * constraints, append-only history) are proved by scripts/verify-billing-responsibility.ts.
 * Synthetic data only.
 */
vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  event: { id: "event-1", billingMode: "DEFERRED_ORGANIZATION_INVOICE", invoiceGrouping: "PER_CHURCH" } as Row,
  registrations: [] as Row[],
  responsibilities: [] as Row[],
  changes: [] as Row[],
  audits: [] as Row[],
  contacts: [] as Row[],
  organizations: [] as Row[],
}));

function registrationRow(source: Row) {
  const stored = state.responsibilities.find((row) => row.registrationId === source.id) ?? null;
  return {
    id: source.id,
    confirmationCode: source.confirmationCode ?? `C-${String(source.id)}`,
    status: source.status ?? "CONFIRMED",
    totalAmount: { toString: () => "100.00" },
    location: null,
    accountHolderPerson: { firstName: "Pat", lastName: "Example" },
    clubRegistration: source.club ?? null,
    groupRegistration: source.group ?? null,
    billingResponsibility: stored && {
      ...stored,
      organization: stored.organizationId ? { id: stored.organizationId, name: `Org ${String(stored.organizationId)}` } : null,
      person: null,
    },
    publicFormSubmission: { responses: source.responses ?? {} },
    operations: [],
    _count: { attendees: 5 },
  };
}

const fakeDb = {
  event: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === state.event.id ? state.event : null)), update: vi.fn(async ({ data }: { data: Row }) => Object.assign(state.event, data)) },
  registration: {
    findMany: vi.fn(async ({ where }: { where: { eventId: string } }) => state.registrations.filter((row) => row.eventId === where.eventId).map(registrationRow)),
    findFirst: vi.fn(async ({ where }: { where: { id: string; eventId: string } }) => {
      const source = state.registrations.find((row) => row.id === where.id && row.eventId === where.eventId);
      return source ? registrationRow(source) : null;
    }),
  },
  organization: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.organizations.find((row) => row.id === where.id) ?? null),
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async ({ where }: { where: { id: string; type?: { in: string[] } } }) => state.organizations.find((row) => row.id === where.id && row.isActive && (!where.type || where.type.in.includes(row.type as string))) ?? null),
  },
  registrationBillingResponsibility: {
    count: vi.fn(async ({ where }: { where: { eventId: string; organizationId: string } }) => state.responsibilities.filter((row) => row.eventId === where.eventId && row.organizationId === where.organizationId).length),
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (state.responsibilities.some((row) => row.registrationId === data.registrationId)) throw Object.assign(new Error("unique"), { code: "P2002" });
      state.responsibilities.push({ ...data });
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = state.responsibilities.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
      hit.forEach((row) => Object.assign(row, data));
      return { count: hit.length };
    }),
    update: vi.fn(async ({ where, data }: { where: { registrationId: string }; data: Row }) => {
      Object.assign(state.responsibilities.find((row) => row.registrationId === where.registrationId)!, data);
    }),
    upsert: vi.fn(async ({ where, create, update }: { where: { registrationId: string }; create: Row; update: Row }) => {
      const existing = state.responsibilities.find((row) => row.registrationId === where.registrationId);
      if (existing) Object.assign(existing, update); else state.responsibilities.push({ ...create });
    }),
  },
  registrationBillingResponsibilityChange: { create: vi.fn(async ({ data }: { data: Row }) => { state.changes.push({ ...data }); }), findMany: vi.fn(async () => []) },
  clubEventRegistration: {
    count: vi.fn(async ({ where }: { where: { eventId: string; organization: { parentOrganizationId: string } } }) =>
      state.registrations.filter((row) => row.eventId === where.eventId && (row.club as { organization?: { parentOrganizationId?: string } } | undefined)?.organization?.parentOrganizationId === where.organization.parentOrganizationId).length),
  },
  organizationBillingContact: {
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = state.contacts.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
      hit.forEach((row) => Object.assign(row, data));
      return { count: hit.length };
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (state.contacts.some((row) => row.organizationId === data.organizationId && row.effectiveTo === null)) throw Object.assign(new Error("unique"), { code: "P2002" });
      const row = { id: `contact-${state.contacts.length + 1}`, effectiveTo: null, verifiedAt: null, ...data };
      state.contacts.push(row);
      return { id: row.id };
    }),
    findFirst: vi.fn(async ({ where }: { where: Row }) => state.contacts.find((row) => row.id === where.id && row.organizationId === where.organizationId && row.effectiveTo === null) ?? null),
    findMany: vi.fn(async ({ where }: { where: { organizationId: { in: string[] }; effectiveTo?: null } }) =>
      state.contacts.filter((row) => where.organizationId.in.includes(row.organizationId as string) && (where.effectiveTo === undefined || row.effectiveTo === null))
        .map((row) => ({ effectiveFrom: new Date("2026-10-01T00:00:00Z"), ...row }))),
  },
  auditLog: { create: vi.fn(async ({ data }: { data: Row }) => { state.audits.push({ ...data }); }) },
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(fakeDb)),
};
vi.mock("@/lib/prisma", () => ({ getPrisma: () => fakeDb }));

import { AccessDeniedError } from "@/modules/access/authorization";
import {
  BillingResponsibilityError,
  clearResponsibilityOverride,
  getBillingResponsibilityView,
  getOrganizationBillingContactAdminView,
  endOrganizationBillingContact,
  linkRegistrationToOrganization,
  resolveEventBillingResponsibility,
  setInvoiceGrouping,
  setOrganizationBillingContact,
  verifyOrganizationBillingContact,
} from "@/modules/billing-responsibility/repository";

const club = (id: string, parent: string | null) => ({ organization: { id, name: `Club ${id}`, parentOrganizationId: parent, parentOrganization: parent ? { id: parent, name: `Org ${parent}` } : null } });
const contact = { name: "Terry Treasurer", email: "treasurer@example.test", phone: null, roleLabel: "Treasurer" };

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state.event, { billingMode: "DEFERRED_ORGANIZATION_INVOICE", invoiceGrouping: "PER_CHURCH" });
  state.registrations = [
    { id: "r-club-a", eventId: "event-1", club: club("club-1", "church-1") },
    { id: "r-club-b", eventId: "event-1", club: club("club-2", "church-1") },
    { id: "r-orphan", eventId: "event-1", club: club("club-3", null) },
    { id: "r-group", eventId: "event-1", group: { billingPerson: { id: "person-1", firstName: "Gail", lastName: "Group", normalizedEmail: "gail@example.test" } } },
    { id: "r-typed", eventId: "event-1", responses: { church_name: "Typed Church" } },
    { id: "r-other-event", eventId: "event-2", club: club("club-9", "church-9") },
  ];
  state.responsibilities = [];
  state.changes = [];
  state.audits = [];
  state.contacts = [];
  state.organizations = [
    { id: "church-1", isActive: true, type: "CHURCH" },
    { id: "church-2", isActive: true, type: "CHURCH" },
    { id: "closed", isActive: false, type: "CHURCH" },
    { id: "company-1", isActive: true, type: "COMPANY" },
    { id: "bookstore-1", isActive: true, type: "BOOKSTORE" },
  ];
});

describe("resolver and backfill (#165)", () => {
  it("dry run reports and writes nothing; the free-text registration is unresolved and carries only a hint", async () => {
    const report = await resolveEventBillingResponsibility("event-1", { apply: false });
    expect(report).toMatchObject({ dryRun: true, total: 5, created: 5, updated: 0 });
    expect(state.responsibilities).toHaveLength(0);
    expect(report.unresolved.map((entry) => entry.registrationId).sort()).toEqual(["r-orphan", "r-typed"]);
    expect(report.unresolved.find((entry) => entry.registrationId === "r-typed")).toMatchObject({ reason: "UNRESOLVED_NO_ORGANIZATION_LINKED", hint: "Typed Church" });
    expect(report.unresolved.find((entry) => entry.registrationId === "r-orphan")).toMatchObject({ reason: "UNRESOLVED_CLUB_HAS_NO_CHURCH" });
  });

  it("records clubs under their church, a group under its person, and never links ambiguity", async () => {
    await resolveEventBillingResponsibility("event-1", { apply: true, actorUserId: "user-1" });
    const byRegistration = Object.fromEntries(state.responsibilities.map((row) => [row.registrationId as string, row]));
    expect(byRegistration["r-club-a"]).toMatchObject({ kind: "ORGANIZATION", organizationId: "church-1", source: "CLUB_SPONSORING_CHURCH" });
    expect(byRegistration["r-club-b"]).toMatchObject({ kind: "ORGANIZATION", organizationId: "church-1" });
    expect(byRegistration["r-group"]).toMatchObject({ kind: "PERSON", personId: "person-1", source: "GROUP_BILLING_PERSON" });
    expect(byRegistration["r-orphan"]).toMatchObject({ kind: "UNRESOLVED", organizationId: null, personId: null });
    expect(byRegistration["r-typed"]).toMatchObject({ kind: "UNRESOLVED", organizationId: null, personId: null });
    expect(byRegistration["r-other-event"]).toBeUndefined();
    expect(state.changes).toHaveLength(5);
  });

  it("is idempotent on retry: a second run changes and records nothing", async () => {
    await resolveEventBillingResponsibility("event-1", { apply: true, actorUserId: "user-1" });
    const snapshot = JSON.stringify(state.responsibilities);
    const again = await resolveEventBillingResponsibility("event-1", { apply: true, actorUserId: "user-1" });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 5 });
    expect(JSON.stringify(state.responsibilities)).toBe(snapshot);
    expect(state.changes).toHaveLength(5);
    expect(state.audits.filter((entry) => entry.action === "BILLING_RESPONSIBILITY_RESOLVED")).toHaveLength(1);
  });

  it("re-resolves a rule-derived row when the club's church changes, and keeps the history", async () => {
    await resolveEventBillingResponsibility("event-1", { apply: true });
    state.registrations[0]!.club = club("club-1", "church-2");
    const report = await resolveEventBillingResponsibility("event-1", { apply: true });
    expect(report).toMatchObject({ updated: 1 });
    expect(state.responsibilities.find((row) => row.registrationId === "r-club-a")).toMatchObject({ organizationId: "church-2" });
    expect(state.changes.filter((row) => row.registrationId === "r-club-a").map((row) => row.changeType)).toEqual(["RESOLVED", "RE_RESOLVED"]);
  });

  it("refuses an event that is not billed to organizations", async () => {
    state.event.billingMode = "ATTENDEE_PAY";
    await expect(resolveEventBillingResponsibility("event-1", { apply: true })).rejects.toMatchObject({ code: "NOT_DEFERRED_EVENT" });
  });
});

describe("staff decisions (#165)", () => {
  it("links an unresolved registration without a reason, audited with ids only", async () => {
    await resolveEventBillingResponsibility("event-1", { apply: true });
    const result = await linkRegistrationToOrganization({ eventId: "event-1", registrationId: "r-typed", organizationId: "church-2", actorUserId: "user-1" });
    expect(result).toMatchObject({ changed: true, source: "STAFF_LINKED" });
    expect(state.responsibilities.find((row) => row.registrationId === "r-typed")).toMatchObject({ kind: "ORGANIZATION", organizationId: "church-2", source: "STAFF_LINKED" });
    const audit = state.audits.find((entry) => entry.action === "BILLING_RESPONSIBILITY_LINKED")!;
    expect(JSON.stringify(audit.metadata)).not.toContain("Typed Church");
  });

  it("needs a reason to override a rule-derived party, and the override survives re-resolution", async () => {
    await resolveEventBillingResponsibility("event-1", { apply: true });
    await expect(linkRegistrationToOrganization({ eventId: "event-1", registrationId: "r-club-a", organizationId: "church-2", actorUserId: "user-1" }))
      .rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await linkRegistrationToOrganization({ eventId: "event-1", registrationId: "r-club-a", organizationId: "church-2", reason: "Billed through the school board.", actorUserId: "user-1" });
    const report = await resolveEventBillingResponsibility("event-1", { apply: true });
    expect(report.keptStaffDecisions).toBe(1);
    expect(state.responsibilities.find((row) => row.registrationId === "r-club-a")).toMatchObject({ organizationId: "church-2", source: "STAFF_OVERRIDE" });
    // The retry changes nothing either.
    expect((await resolveEventBillingResponsibility("event-1", { apply: true })).created).toBe(0);
  });

  it("clearing an override returns to the rule's answer with a history row", async () => {
    await resolveEventBillingResponsibility("event-1", { apply: true });
    await linkRegistrationToOrganization({ eventId: "event-1", registrationId: "r-club-a", organizationId: "church-2", reason: "Reason.", actorUserId: "user-1" });
    await clearResponsibilityOverride({ eventId: "event-1", registrationId: "r-club-a", actorUserId: "user-1" });
    expect(state.responsibilities.find((row) => row.registrationId === "r-club-a")).toMatchObject({ organizationId: "church-1", source: "CLUB_SPONSORING_CHURCH" });
    expect(state.changes.at(-1)).toMatchObject({ changeType: "OVERRIDE_CLEARED", fromSource: "STAFF_OVERRIDE" });
    await expect(clearResponsibilityOverride({ eventId: "event-1", registrationId: "r-club-a", actorUserId: "user-1" })).rejects.toMatchObject({ code: "NOT_AN_OVERRIDE" });
  });

  it("refuses a registration from another event and an ineligible or closed organization", async () => {
    await expect(linkRegistrationToOrganization({ eventId: "event-1", registrationId: "r-other-event", organizationId: "church-2", reason: "x", actorUserId: "user-1" }))
      .rejects.toMatchObject({ code: "REGISTRATION_NOT_FOUND" });
    await expect(linkRegistrationToOrganization({ eventId: "event-1", registrationId: "r-typed", organizationId: "closed", actorUserId: "user-1" }))
      .rejects.toMatchObject({ code: "ORGANIZATION_NOT_ELIGIBLE" });
    await expect(linkRegistrationToOrganization({ eventId: "event-1", registrationId: "r-typed", organizationId: "missing", actorUserId: "user-1" }))
      .rejects.toBeInstanceOf(BillingResponsibilityError);
    expect(state.responsibilities).toHaveLength(0);
  });
});

describe("grouping setting (#165)", () => {
  it("changes the setting with a before-and-after audit and does nothing when unchanged", async () => {
    expect(await setInvoiceGrouping({ eventId: "event-1", invoiceGrouping: "PER_CHURCH", actorUserId: "user-1" })).toEqual({ changed: false });
    expect(await setInvoiceGrouping({ eventId: "event-1", invoiceGrouping: "PER_CLUB", actorUserId: "user-1" })).toEqual({ changed: true });
    expect(state.event.invoiceGrouping).toBe("PER_CLUB");
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ action: "INVOICE_GROUPING_CHANGED", metadata: { before: "PER_CHURCH", after: "PER_CLUB" } });
  });
});

describe("billing contacts (#165): conference-wide, system administrators only", () => {
  const admin = { id: "admin-1", globalRole: "SYSTEM_ADMIN" };
  const admin2 = { id: "admin-2", globalRole: "SYSTEM_ADMIN" };
  const financeManager = { id: "user-finance", globalRole: null };

  it("replacing a contact ends the previous one, keeps it in the history, and leaves one active, unverified", async () => {
    await setOrganizationBillingContact({ organizationId: "church-1", contact, actor: admin });
    await verifyOrganizationBillingContact({ organizationId: "church-1", contactId: "contact-1", actor: admin });
    const replaced = await setOrganizationBillingContact({ organizationId: "church-1", contact: { ...contact, name: "New Treasurer" }, actor: admin2 });
    expect(replaced.replaced).toBe(true);
    expect(state.contacts).toHaveLength(2);
    expect(state.contacts.filter((row) => row.effectiveTo === null)).toHaveLength(1);
    expect(state.contacts[0]).toMatchObject({ endedByUserId: "admin-2" });
    expect(state.contacts[1]).toMatchObject({ name: "New Treasurer", source: "STAFF_ENTERED", createdByUserId: "admin-2", verifiedAt: null });
    const audit = state.audits.filter((entry) => String(entry.action).startsWith("BILLING_CONTACT"));
    expect(audit.map((entry) => entry.action)).toEqual(["BILLING_CONTACT_ADDED", "BILLING_CONTACT_VERIFIED", "BILLING_CONTACT_REPLACED"]);
    // Conference-wide: no event on the audit row, ids only.
    expect(audit.every((entry) => !("eventId" in entry) && entry.entityType === "Organization" && entry.entityId === "church-1")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("treasurer@example.test");
    expect(JSON.stringify(audit)).not.toContain("New Treasurer");
  });

  it("keeps contacts for active churches, companies, schools, clubs and ministries only", async () => {
    for (const organizationId of ["closed", "bookstore-1", "missing"]) {
      await expect(setOrganizationBillingContact({ organizationId, contact, actor: admin })).rejects.toMatchObject({ code: "ORGANIZATION_NOT_ELIGIBLE" });
    }
    expect(state.contacts).toHaveLength(0);
  });

  it("keeps a billing contact for a company that sponsors a club (#822)", async () => {
    await expect(setOrganizationBillingContact({ organizationId: "company-1", contact, actor: admin })).resolves.toMatchObject({ replaced: false });
    expect(state.contacts).toHaveLength(1);
  });

  it("refuses a finance manager or anyone who is not a system administrator, for every contact action", async () => {
    await setOrganizationBillingContact({ organizationId: "church-1", contact, actor: admin });
    for (const actor of [financeManager, { id: "nobody" }]) {
      await expect(setOrganizationBillingContact({ organizationId: "church-1", contact, actor })).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(verifyOrganizationBillingContact({ organizationId: "church-1", contactId: "contact-1", actor })).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(endOrganizationBillingContact({ organizationId: "church-1", contactId: "contact-1", actor })).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(getOrganizationBillingContactAdminView("church-1", actor)).rejects.toBeInstanceOf(AccessDeniedError);
    }
    expect(state.contacts).toHaveLength(1);
    expect(state.contacts[0]).toMatchObject({ effectiveTo: null, verifiedAt: null });
  });

  it("ends a contact without deleting it, and refuses to verify or end one that is no longer active", async () => {
    await setOrganizationBillingContact({ organizationId: "church-1", contact, actor: admin });
    await endOrganizationBillingContact({ organizationId: "church-1", contactId: "contact-1", reason: "Left the church.", actor: admin });
    expect(state.contacts).toHaveLength(1);
    expect(state.contacts[0]).toMatchObject({ endReason: "Left the church." });
    await expect(verifyOrganizationBillingContact({ organizationId: "church-1", contactId: "contact-1", actor: admin })).rejects.toMatchObject({ code: "CONTACT_NOT_FOUND" });
  });

  it("reports a concurrent change when the database refuses a second active contact", async () => {
    const { Prisma } = await import("@prisma/client");
    fakeDb.organizationBillingContact.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" }));
    await expect(setOrganizationBillingContact({ organizationId: "church-1", contact, actor: admin })).rejects.toMatchObject({ code: "CONCURRENT_CHANGE" });
  });

  it("event finance staff see only the active contact's name, role and email, never a phone or history", async () => {
    await setOrganizationBillingContact({ organizationId: "church-1", contact: { ...contact, phone: "(515) 555-0100" }, actor: admin });
    await setOrganizationBillingContact({ organizationId: "church-1", contact: { ...contact, name: "Current Treasurer", phone: "(515) 555-0101" }, actor: admin });
    const view = await getBillingResponsibilityView("event-1");
    const group = view.groups.find((entry) => entry.party.kind === "ORGANIZATION" && entry.party.id === "church-1")!;
    expect(group.contact).toMatchObject({ name: "Current Treasurer", email: "treasurer@example.test", roleLabel: "Treasurer" });
    expect(group.readiness).toBe("NOT_VERIFIED");
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("555");
    expect(serialized).not.toContain("Terry Treasurer");
    expect(serialized).not.toContain("history");
  });
});

describe("outdated recorded rows (#165)", () => {
  it("shows the rule's current answer for a stale rule-derived row, counts it, and the resolver updates it", async () => {
    await resolveEventBillingResponsibility("event-1", { apply: true });
    state.registrations[0]!.club = club("club-1", "church-2");
    const stale = await getBillingResponsibilityView("event-1");
    expect(stale.outdatedCount).toBe(1);
    const line = stale.groups.flatMap((group) => group.lines).find((entry) => entry.registrationId === "r-club-a")!;
    expect(line).toMatchObject({ outdated: true, recorded: true, party: { kind: "ORGANIZATION", id: "church-2" } });
    await resolveEventBillingResponsibility("event-1", { apply: true });
    expect((await getBillingResponsibilityView("event-1")).outdatedCount).toBe(0);
  });

  it("never flags a staff decision as outdated", async () => {
    await resolveEventBillingResponsibility("event-1", { apply: true });
    await linkRegistrationToOrganization({ eventId: "event-1", registrationId: "r-club-a", organizationId: "church-2", reason: "Reason.", actorUserId: "user-1" });
    state.registrations[0]!.club = club("club-1", "church-1-moved");
    expect((await getBillingResponsibilityView("event-1")).outdatedCount).toBe(0);
  });
});

describe("concurrent staff decisions (#165)", () => {
  it("reports a concurrent change instead of overwriting when the row changed under a link or a clear", async () => {
    await resolveEventBillingResponsibility("event-1", { apply: true });
    fakeDb.registrationBillingResponsibility.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(linkRegistrationToOrganization({ eventId: "event-1", registrationId: "r-club-a", organizationId: "church-2", reason: "Reason.", actorUserId: "user-1" }))
      .rejects.toMatchObject({ code: "CONCURRENT_CHANGE" });
    await linkRegistrationToOrganization({ eventId: "event-1", registrationId: "r-club-a", organizationId: "church-2", reason: "Reason.", actorUserId: "user-1" });
    fakeDb.registrationBillingResponsibility.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(clearResponsibilityOverride({ eventId: "event-1", registrationId: "r-club-a", actorUserId: "user-1" })).rejects.toMatchObject({ code: "CONCURRENT_CHANGE" });
    expect(state.responsibilities.find((row) => row.registrationId === "r-club-a")).toMatchObject({ source: "STAFF_OVERRIDE", organizationId: "church-2" });
  });
});
