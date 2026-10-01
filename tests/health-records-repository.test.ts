/* eslint-disable @typescript-eslint/no-explicit-any -- a loose in-memory stand-in for the Prisma client */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashOpaqueToken } from "@/modules/access/tokens";
import { healthMarkers, syntheticRecord } from "./health-records-fixtures";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  env: { HEALTH_RECORDS_ENABLED: true, SECRET_ENCRYPTION_KEY: "a-synthetic-encryption-key-for-health-record-tests", APP_BASE_URL: "https://events.imsda.test" } as Record<string, unknown>,
  audit: [] as Array<Record<string, unknown>>,
  records: [] as Array<Record<string, any>>,
  fields: [] as Array<Record<string, any>>,
  links: [] as Array<Record<string, any>>,
  outbox: [] as Array<Record<string, any>>,
  prismaTouched: vi.fn(),
  emailConfigured: true,
  members: [] as Array<Record<string, any>>,
  eventRegistrations: [] as Array<Record<string, any>>,
}));

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const condition = expected as Record<string, unknown>;
      if ("gt" in condition) return (row[key] as Date) > (condition.gt as Date);
      if ("in" in condition) return (condition.in as unknown[]).includes(row[key]);
      return true;
    }
    return row[key] === expected;
  });
}

const client: any = {
  clubRosterMember: {
    findFirst: async ({ where }: { where: Row }) => {
      if (where.personId) {
        return state.members.find((member) => member.organizationId === where.organizationId && member.personId === where.personId && member.clubYear === where.clubYear && member.status === where.status) ?? null;
      }
      state.prismaTouched("clubRosterMember.findFirst");
      return state.members.find((member) => member.id === where.id && member.organizationId === where.organizationId && member.status === "ACTIVE" && (where.clubYear === undefined || member.clubYear === where.clubYear)) ?? null;
    },
  },
  clubEventRegistration: {
    findFirst: async ({ where }: { where: Row }) => {
      state.prismaTouched("clubEventRegistration.findFirst");
      const registration = where.registration as { status: { in: string[] }; attendees: { some: { personId: string } } };
      return state.eventRegistrations.find((row) => row.eventId === where.eventId
        && row.organizationId === where.organizationId
        && registration.status.in.includes(row.status)
        && row.attendeePersonIds.includes(registration.attendees.some.personId)) ?? null;
    },
  },
  healthRecord: {
    findUnique: async ({ where }: { where: Row }) => {
      state.prismaTouched("healthRecord.findUnique");
      const record = state.records.find((row) => row.rosterMemberId === where.rosterMemberId);
      return record ? { ...record, fields: state.fields.filter((field) => field.recordId === record.id) } : null;
    },
    findFirst: async ({ where }: { where: Row }) => {
      state.prismaTouched("healthRecord.findFirst");
      const personId = (where.rosterMember as { personId: string }).personId;
      const record = state.records.find((row) => row.organizationId === where.organizationId && state.members.find((m) => m.id === row.rosterMemberId)?.personId === personId);
      return record ? { ...record, fields: state.fields.filter((field) => field.recordId === record.id) } : null;
    },
    findMany: async ({ where }: { where: Row }) => state.records.filter((row) => matches(row, where)),
    create: async ({ data }: { data: Row }) => {
      state.prismaTouched("healthRecord.create");
      const { fields, ...record } = data as { fields?: { create: Row[] } } & Row;
      state.records.push({ ...record });
      for (const field of fields?.create ?? []) state.fields.push({ recordId: record.id, ...field });
      return record;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      state.prismaTouched("healthRecord.update");
      Object.assign(state.records.find((row) => row.id === where.id)!, data);
    },
  },
  healthRecordField: {
    deleteMany: async ({ where }: { where: Row }) => {
      state.fields = state.fields.filter((field) => field.recordId !== where.recordId);
    },
    createMany: async ({ data }: { data: Row[] }) => {
      state.fields.push(...data);
    },
  },
  healthRecordLink: {
    create: async ({ data }: { data: Row }) => {
      const link = { id: `link-${state.links.length + 1}`, status: "OPEN", tokenHash: null, messageId: null, ...data };
      state.links.push(link);
      return link;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      Object.assign(state.links.find((row) => row.id === where.id)!, data);
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hits = state.links.filter((row) => matches(row, where));
      for (const hit of hits) Object.assign(hit, data);
      return { count: hits.length };
    },
    findUnique: async ({ where }: { where: Row }) => {
      if (where.messageId) return state.links.find((row) => row.messageId === where.messageId) ?? null;
      const link = state.links.find((row) => row.tokenHash && row.tokenHash === where.tokenHash);
      if (!link) return null;
      const member = state.members.find((row) => row.id === link.rosterMemberId)!;
      return { ...link, rosterMember: { id: member.id, personId: member.personId, status: member.status, clubYear: member.clubYear, person: member.person, organization: member.organization } };
    },
    findFirst: async ({ where }: { where: Row }) => state.links.find((row) => matches(row, where)) ?? null,
    findMany: async ({ where }: { where: Row }) => state.links.filter((row) => matches(row, where)),
  },
  messageOutbox: {
    create: async ({ data }: { data: Row }) => {
      const message = { id: `message-${state.outbox.length + 1}`, ...data };
      state.outbox.push(message);
      return message;
    },
  },
  $transaction: async (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => state.env }));
vi.mock("@/modules/audit/audit-service", () => ({
  writeAuditLog: async (entry: Record<string, unknown>) => {
    state.audit.push(entry);
  },
}));
vi.mock("@/modules/communications/account-email", () => ({
  isAccountEmailConfigured: () => state.emailConfigured,
  getAccountEmailSender: () => ({ name: "IMSDA Events", address: "events@example.test", replyTo: null }),
}));

import { openHealthField } from "@/modules/health-records/crypto";
import { HealthRecordError } from "@/modules/health-records/errors";
import { prepareHealthRecordLinkBodyForDelivery } from "@/modules/health-records/link-email";
import {
  confirmHealthRecord,
  createHealthRecordLink,
  healthNoteFlagsForRoster,
  healthSummariesForMembers,
  listHealthRecordLinks,
  resolveHealthLinkForFill,
  revokeHealthRecordLink,
  saveHealthRecord,
  submitHealthRecordViaLink,
  viewHealthRecord,
} from "@/modules/health-records/repository";
import type { HealthViewer } from "@/modules/health-records/domain";

const now = new Date("2026-10-05T15:00:00Z");
const leader: HealthViewer = { kind: "CLUB_LEADER", organizationId: "club-a", accountId: "acct-1" };
const otherLeader: HealthViewer = { kind: "CLUB_LEADER", organizationId: "club-b", accountId: "acct-9" };
const staff: HealthViewer = { kind: "HEALTH_ROLE", userId: "staff-1", eventIds: ["event-1"] };
const admin: HealthViewer = { kind: "SYSTEM_ADMIN", userId: "admin-1" };
const coordinator: HealthViewer = { kind: "AREA_COORDINATOR", accountId: "acct-coord" };
const TOKEN = "T".repeat(43);

function resetState() {
  state.env.HEALTH_RECORDS_ENABLED = true;
  state.audit = [];
  state.records = [];
  state.fields = [];
  state.links = [];
  state.outbox = [];
  state.eventRegistrations = [{
    eventId: "event-1",
    organizationId: "club-a",
    status: "CONFIRMED",
    attendeePersonIds: ["person-1"],
    event: { timezone: "America/Chicago", endsAt: new Date("2026-10-11T18:00:00Z"), isPublished: true },
  }];
  state.emailConfigured = true;
  state.prismaTouched.mockClear();
  state.members = [{
    id: "member-1",
    organizationId: "club-a",
    clubYear: "2026-27",
    status: "ACTIVE",
    personId: "person-1",
    person: { firstName: "Casey", lastName: "Sample" },
    organization: { name: "Synthetic Pathfinders", isActive: true, type: "CLUB", parentOrganization: { name: "Synthetic Church" } },
  }];
}

describe("with HEALTH_RECORDS_ENABLED off", () => {
  beforeEach(() => {
    resetState();
    state.env.HEALTH_RECORDS_ENABLED = false;
  });

  it("refuses every operation as not found, touches no table and stores nothing", async () => {
    const attempts = [
      () => viewHealthRecord(leader, "club-a", "member-1", now),
      () => saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now),
      () => confirmHealthRecord(leader, "club-a", "member-1", now),
      () => healthSummariesForMembers(leader, "club-a", ["member-1"], now),
      () => createHealthRecordLink(leader, { organizationId: "club-a", rosterMemberId: "member-1", recipientEmail: "p@example.test" }, now),
      () => listHealthRecordLinks(leader, "club-a", "member-1", now),
      () => revokeHealthRecordLink(leader, "club-a", "link-1", now),
      () => resolveHealthLinkForFill(TOKEN, now),
      () => submitHealthRecordViaLink(TOKEN, syntheticRecord, now),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ name: "HealthRecordError", code: "NOT_FOUND" });
    }
    expect(state.prismaTouched).not.toHaveBeenCalled();
    expect(state.records).toHaveLength(0);
    expect(state.fields).toHaveLength(0);
    expect(state.links).toHaveLength(0);
    expect(state.outbox).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });

  it("treats anything but the exact value true as off, and an unreadable environment as off", async () => {
    const { healthRecordsEnabled } = await import("@/modules/health-records/flag");
    for (const value of [undefined, false, "TRUE", "yes", 1]) {
      state.env.HEALTH_RECORDS_ENABLED = value;
      expect(healthRecordsEnabled()).toBe(false);
    }
    state.env.HEALTH_RECORDS_ENABLED = true;
    expect(healthRecordsEnabled()).toBe(true);
  });
});

describe("director entry and viewing", () => {
  beforeEach(resetState);

  it("seals every field separately and leaves no health text in the stored rows", async () => {
    await saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now);
    expect(state.records).toHaveLength(1);
    const record = state.records[0]!;
    expect(record.hasHealthNote).toBe(true);
    expect(record.confirmedClubYear).toBe("2026-27");
    const stored = JSON.stringify([state.records, state.fields]);
    for (const marker of healthMarkers) expect(stored).not.toContain(marker);
    // One ciphertext per field, none shared, each in the sealed format.
    const sealed = state.fields.map((field) => field.sealedValue as string);
    expect(new Set(sealed).size).toBe(sealed.length);
    expect(sealed.every((value) => value.startsWith("v1."))).toBe(true);
    expect(state.fields.map((field) => field.fieldKey)).toContain("allergyDetails");
  });

  it("opens a field only under its own record and field", async () => {
    await saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now);
    const recordId = state.records[0]!.id as string;
    const medications = state.fields.find((field) => field.fieldKey === "medications")!;
    expect(openHealthField(recordId, "medications", medications.sealedValue)).toBe("Synthetic medication note");
    expect(() => openHealthField(recordId, "allergyDetails", medications.sealedValue)).toThrow(HealthRecordError);
    expect(() => openHealthField("another-record", "medications", medications.sealedValue)).toThrow(HealthRecordError);
  });

  it("round-trips through the Health tab and audits the view without any health text", async () => {
    await saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now);
    state.audit = [];
    const view = await viewHealthRecord(leader, "club-a", "member-1", now);
    expect(view.status).toBe("CURRENT");
    expect(view.canEdit).toBe(true);
    expect(view.values.medications).toBe("Synthetic medication note");
    expect(view.club).toEqual({ name: "Synthetic Pathfinders", sponsoringChurch: "Synthetic Church" });
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({ action: "HEALTH_RECORD_VIEWED", entityType: "HealthRecord" });
    for (const marker of healthMarkers) expect(JSON.stringify(state.audit)).not.toContain(marker);
  });

  it("audits every create and update with a field count and no health text", async () => {
    await saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now);
    await saveHealthRecord(leader, "club-a", "member-1", { ...syntheticRecord, medications: "Synthetic second note" }, now);
    expect(state.audit.map((entry) => entry.action)).toEqual(["HEALTH_RECORD_CREATED", "HEALTH_RECORD_UPDATED"]);
    expect(state.records).toHaveLength(1);
    const text = JSON.stringify(state.audit);
    for (const marker of [...healthMarkers, "Synthetic second note"]) expect(text).not.toContain(marker);
    expect(state.audit[0]!.metadata).toMatchObject({ fieldCount: expect.any(Number), organizationId: "club-a", rosterMemberId: "member-1" });
  });

  it("shows Needs update for a record not confirmed this club year, and confirming clears it", async () => {
    await saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now);
    state.records[0]!.confirmedClubYear = "2025-26";
    expect((await viewHealthRecord(leader, "club-a", "member-1", now)).status).toBe("NEEDS_UPDATE");
    expect((await healthSummariesForMembers(leader, "club-a", ["member-1"], now))["member-1"]).toEqual({ status: "NEEDS_UPDATE", hasHealthNote: true });
    await confirmHealthRecord(leader, "club-a", "member-1", now);
    expect(state.records[0]!.confirmedClubYear).toBe("2026-27");
    expect((await viewHealthRecord(leader, "club-a", "member-1", now)).status).toBe("CURRENT");
    expect(state.audit.map((entry) => entry.action)).toContain("HEALTH_RECORD_CONFIRMED");
  });

  it("carries a previous year's record to the person's new roster row as Needs update", async () => {
    state.members[0]!.clubYear = "2025-26";
    await saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, new Date("2025-10-05T15:00:00Z"));
    state.members.push({ ...state.members[0]!, id: "member-2", clubYear: "2026-27" });
    const view = await viewHealthRecord(leader, "club-a", "member-2", now);
    expect(view.status).toBe("NEEDS_UPDATE");
    expect(view.values.medications).toBe("Synthetic medication note");
    await confirmHealthRecord(leader, "club-a", "member-2", now);
    expect(state.records[0]!.rosterMemberId).toBe("member-2");
  });

  it("denies another club's director as not found, before anything is read or written", async () => {
    await expect(viewHealthRecord(otherLeader, "club-a", "member-1", now)).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    await expect(saveHealthRecord(otherLeader, "club-a", "member-1", syntheticRecord, now)).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    expect(state.audit).toHaveLength(0);
    expect(state.records).toHaveLength(0);
  });

  it("lets a system administrator view any club but never edit, confirm or send links", async () => {
    await saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now);
    state.audit = [];
    const view = await viewHealthRecord(admin, "club-a", "member-1", now);
    expect(view.canEdit).toBe(false);
    expect(state.audit[0]).toMatchObject({ action: "HEALTH_RECORD_VIEWED", actorUserId: "admin-1", metadata: { viewerKind: "SYSTEM_ADMIN" } });
    await expect(saveHealthRecord(admin, "club-a", "member-1", syntheticRecord, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(confirmHealthRecord(admin, "club-a", "member-1", now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createHealthRecordLink(admin, { organizationId: "club-a", rosterMemberId: "member-1", recipientEmail: "p@example.test" }, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("records the act-as id when a system administrator is acting as a director", async () => {
    await saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now);
    state.audit = [];
    await viewHealthRecord({ kind: "SYSTEM_ADMIN", userId: "admin-1", actAsId: "act-1" }, "club-a", "member-1", now);
    expect(state.audit[0]!.metadata).toMatchObject({ viewerKind: "SYSTEM_ADMIN", actAsId: "act-1" });
  });

  it("lets the health role view an attendee of its own event only, inside the window, and never edit", async () => {
    await saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now);
    state.audit = [];
    const view = await viewHealthRecord(staff, "club-a", "member-1", now, { eventId: "event-1" });
    expect(view.canEdit).toBe(false);
    expect(state.audit[0]).toMatchObject({ actorUserId: "staff-1", metadata: { viewerKind: "HEALTH_ROLE", eventId: "event-1" } });
    expect(state.audit[0]).not.toHaveProperty("eventId");
    // Another event's attendee, no event named, and an event the role does not cover.
    state.eventRegistrations.push({ ...state.eventRegistrations[0]!, eventId: "event-2" });
    await expect(viewHealthRecord(staff, "club-a", "member-1", now, { eventId: "event-2" })).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    await expect(viewHealthRecord(staff, "club-a", "member-1", now)).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    await expect(viewHealthRecord(staff, "club-a", "member-1", new Date("2026-11-11T12:00:00Z"), { eventId: "event-1" })).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    await expect(saveHealthRecord(staff, "club-a", "member-1", syntheticRecord, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(healthSummariesForMembers(staff, "club-a", ["member-1"], now)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not save without a valid consented record, and an error never echoes a value", async () => {
    const error = await saveHealthRecord(leader, "club-a", "member-1", { ...syntheticRecord, consentPhotocopy: false }, now).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HealthRecordError);
    for (const marker of healthMarkers) expect(String((error as Error).message) + JSON.stringify((error as HealthRecordError).issues)).not.toContain(marker);
    expect(state.records).toHaveLength(0);
  });

  it("refuses to save when the encryption key is missing", async () => {
    delete state.env.SECRET_ENCRYPTION_KEY;
    await expect(saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now)).rejects.toMatchObject({ code: "ENCRYPTION_NOT_CONFIGURED" });
    expect(state.records).toHaveLength(0);
    state.env.SECRET_ENCRYPTION_KEY = "a-synthetic-encryption-key-for-health-record-tests";
  });
});

describe("the parent private link", () => {
  beforeEach(resetState);

  async function sendLink() {
    const created = await createHealthRecordLink(leader, { organizationId: "club-a", rosterMemberId: "member-1", recipientEmail: " Parent@Example.test " }, now);
    // Delivery mints the token and stores only its hash.
    const delivered = await prepareHealthRecordLinkBodyForDelivery({ messageId: created.messageId, bodyText: state.outbox[0]!.bodyTextSnapshot as string, now });
    const url = delivered.bodyText.match(/https:\/\/\S+/)![0];
    return { created, token: decodeURIComponent(url.split("/health-records/")[1]!) };
  }

  it("queues one email whose body holds a sentinel, no token, no child and no health text", async () => {
    await createHealthRecordLink(leader, { organizationId: "club-a", rosterMemberId: "member-1", recipientEmail: "parent@example.test" }, now);
    expect(state.outbox).toHaveLength(1);
    const message = state.outbox[0]!;
    expect(message.templateKey).toBe("HEALTH_RECORD_LINK");
    expect(message.bodyTextSnapshot).toContain("{{health_record_link}}");
    expect(message.bodyTextSnapshot).not.toContain("Casey");
    expect(message.bodyTextSnapshot).not.toMatch(/https?:\/\//);
    expect(state.links[0]!.tokenHash).toBeNull();
    expect(JSON.stringify(state.audit)).not.toContain("parent@example.test");
  });

  it("submits once: the second use of the same link fails and nothing more is stored", async () => {
    const { token } = await sendLink();
    expect(state.links[0]!.tokenHash).toBe(hashOpaqueToken(token));
    const page = await resolveHealthLinkForFill(token, now);
    expect(page).toMatchObject({ clubName: "Synthetic Pathfinders", memberFirstName: "Casey" });
    expect(JSON.stringify(page)).not.toContain("Sample");

    await submitHealthRecordViaLink(token, syntheticRecord, now);
    expect(state.records).toHaveLength(1);
    expect(state.records[0]).toMatchObject({ lastEnteredVia: "LINK", confirmedClubYear: "2026-27" });
    expect(state.links[0]).toMatchObject({ status: "USED", tokenHash: null });
    const fieldCount = state.fields.length;
    await expect(submitHealthRecordViaLink(token, { ...syntheticRecord, medications: "Synthetic replay" }, now)).rejects.toMatchObject({ code: "LINK_UNAVAILABLE" });
    await expect(resolveHealthLinkForFill(token, now)).rejects.toMatchObject({ code: "LINK_UNAVAILABLE" });
    expect(state.fields).toHaveLength(fieldCount);
    expect(state.audit.filter((entry) => entry.action === "HEALTH_RECORD_LINK_SUBMITTED")).toHaveLength(1);
    expect(JSON.stringify(state.audit)).not.toContain("Synthetic medication note");
  });

  it("refuses an expired, withdrawn or malformed link with the same answer", async () => {
    const { token, created } = await sendLink();
    const later = new Date(created.expiresAt.getTime() + 1000);
    await expect(resolveHealthLinkForFill(token, later)).rejects.toMatchObject({ code: "LINK_UNAVAILABLE" });
    await expect(submitHealthRecordViaLink(token, syntheticRecord, later)).rejects.toMatchObject({ code: "LINK_UNAVAILABLE" });
    await expect(resolveHealthLinkForFill("short", now)).rejects.toMatchObject({ code: "LINK_UNAVAILABLE" });
    await revokeHealthRecordLink(leader, "club-a", created.linkId, now);
    await expect(resolveHealthLinkForFill(token, now)).rejects.toMatchObject({ code: "LINK_UNAVAILABLE" });
    expect(state.records).toHaveLength(0);
  });

  it("makes a new link withdraw the earlier open one, and another club cannot withdraw it", async () => {
    const first = await createHealthRecordLink(leader, { organizationId: "club-a", rosterMemberId: "member-1", recipientEmail: "a@example.test" }, now);
    await createHealthRecordLink(leader, { organizationId: "club-a", rosterMemberId: "member-1", recipientEmail: "b@example.test" }, now);
    expect(state.links.find((link) => link.id === first.linkId)!.status).toBe("REVOKED");
    await expect(revokeHealthRecordLink(otherLeader, "club-a", state.links[1]!.id as string, now)).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
  });

  it("does not send a link when email is not configured", async () => {
    state.emailConfigured = false;
    await expect(createHealthRecordLink(leader, { organizationId: "club-a", rosterMemberId: "member-1", recipientEmail: "a@example.test" }, now)).rejects.toMatchObject({ code: "EMAIL_NOT_CONFIGURED" });
    expect(state.outbox).toHaveLength(0);
  });
});

describe("the Area Coordinator's event-scoped view", () => {
  beforeEach(async () => {
    resetState();
    await saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now);
    state.audit = [];
  });

  it("opens an event attendee's full record inside the window, audited with the event and member ids and no health text", async () => {
    const view = await viewHealthRecord(coordinator, "club-a", "member-1", now, { eventId: "event-1" });
    expect(view.values.medications).toBe("Synthetic medication note");
    expect(view.canEdit).toBe(false);
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({
      action: "HEALTH_RECORD_VIEWED",
      metadata: { viewerKind: "AREA_COORDINATOR", actorAttendeeAccountId: "acct-coord", eventId: "event-1", rosterMemberId: "member-1", organizationId: "club-a" },
    });
    // The event id lives in the metadata only: a top-level eventId would list the view in the event staff's audit log.
    expect(state.audit[0]).not.toHaveProperty("eventId");
    for (const marker of healthMarkers) expect(JSON.stringify(state.audit)).not.toContain(marker);
  });

  it("refuses an unpublished event's attendee, with the same not-found as every other miss", async () => {
    state.eventRegistrations[0]!.event.isPublished = false;
    const error = await viewHealthRecord(coordinator, "club-a", "member-1", now, { eventId: "event-1" }).catch((caught: unknown) => caught);
    const roster = await viewHealthRecord(coordinator, "club-a", "member-x", now, { eventId: "event-1" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "MEMBER_NOT_FOUND" });
    expect((error as Error).message).toBe((roster as Error).message);
  });

  it("still opens a record through the 30 days after the event, and not after", async () => {
    await expect(viewHealthRecord(coordinator, "club-a", "member-1", new Date("2026-11-10T12:00:00Z"), { eventId: "event-1" })).resolves.toBeTruthy();
    await expect(viewHealthRecord(coordinator, "club-a", "member-1", new Date("2026-11-11T12:00:00Z"), { eventId: "event-1" })).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
  });

  it("refuses a member who is not an attendee of that event, another event, or a cancelled registration", async () => {
    state.eventRegistrations[0]!.attendeePersonIds = ["someone-else"];
    await expect(viewHealthRecord(coordinator, "club-a", "member-1", now, { eventId: "event-1" })).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    state.eventRegistrations[0]!.attendeePersonIds = ["person-1"];
    await expect(viewHealthRecord(coordinator, "club-a", "member-1", now, { eventId: "event-2" })).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    state.eventRegistrations[0]!.status = "CANCELLED";
    await expect(viewHealthRecord(coordinator, "club-a", "member-1", now, { eventId: "event-1" })).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    expect(state.audit).toHaveLength(0);
  });

  it("refuses without an event id: there is no general browsing", async () => {
    await expect(viewHealthRecord(coordinator, "club-a", "member-1", now)).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    await expect(healthSummariesForMembers(coordinator, "club-a", ["member-1"], now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.audit).toHaveLength(0);
  });

  it("refuses a registration of another club for the same person", async () => {
    state.eventRegistrations[0]!.organizationId = "club-b";
    await expect(viewHealthRecord(coordinator, "club-a", "member-1", now, { eventId: "event-1" })).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
  });

  it("never lets a coordinator edit, confirm or send links", async () => {
    await expect(saveHealthRecord(coordinator, "club-a", "member-1", syntheticRecord, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(confirmHealthRecord(coordinator, "club-a", "member-1", now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createHealthRecordLink(coordinator, { organizationId: "club-a", rosterMemberId: "member-1", recipientEmail: "p@example.test" }, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is not found when the feature is off", async () => {
    state.env.HEALTH_RECORDS_ENABLED = false;
    await expect(viewHealthRecord(coordinator, "club-a", "member-1", now, { eventId: "event-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("an older year's parent link and removal", () => {
  beforeEach(resetState);

  async function sendLinkForMember(memberId: string, at: Date) {
    const created = await createHealthRecordLink(leader, { organizationId: "club-a", rosterMemberId: memberId, recipientEmail: "parent@example.test" }, at);
    const delivered = await prepareHealthRecordLinkBodyForDelivery({ messageId: created.messageId, bodyText: state.outbox.at(-1)!.bodyTextSnapshot as string, now: at });
    return decodeURIComponent(delivered.bodyText.match(/https:\/\/\S+/)![0].split("/health-records/")[1]!);
  }

  it("writes to the person's current-year row and never moves the record back onto the old one", async () => {
    const token = await sendLinkForMember("member-1", now);
    // The club year turns over after the link was sent.
    state.members[0]!.clubYear = "2025-26";
    state.members.push({ ...state.members[0]!, id: "member-2", clubYear: "2026-27" });
    await submitHealthRecordViaLink(token, syntheticRecord, now);
    expect(state.records).toHaveLength(1);
    expect(state.records[0]!.rosterMemberId).toBe("member-2");
    expect(state.audit.at(-1)!.metadata).toMatchObject({ rosterMemberId: "member-2" });
  });

  it("refuses it with the generic answer when the person has no current-year row", async () => {
    const token = await sendLinkForMember("member-1", now);
    state.members[0]!.clubYear = "2025-26";
    await expect(submitHealthRecordViaLink(token, syntheticRecord, now)).rejects.toMatchObject({ code: "LINK_UNAVAILABLE", message: "This private link is invalid or no longer active." });
    await expect(resolveHealthLinkForFill(token, now)).rejects.toMatchObject({ code: "LINK_UNAVAILABLE" });
    expect(state.records).toHaveLength(0);
    expect(state.links[0]!.status).toBe("OPEN");
  });
});

describe("delivery when the feature is switched off", () => {
  beforeEach(resetState);

  it("retires the link and fails the message without minting a token", async () => {
    const created = await createHealthRecordLink(leader, { organizationId: "club-a", rosterMemberId: "member-1", recipientEmail: "parent@example.test" }, now);
    state.env.HEALTH_RECORDS_ENABLED = false;
    await expect(prepareHealthRecordLinkBodyForDelivery({ messageId: created.messageId, bodyText: state.outbox[0]!.bodyTextSnapshot as string, now })).rejects.toThrow(/switched off/);
    expect(state.links[0]).toMatchObject({ status: "REVOKED", tokenHash: null });
  });
});

describe("two first saves racing", () => {
  beforeEach(resetState);

  it("retries once after a unique-key conflict, then answers a friendly conflict", async () => {
    const original = client.healthRecord.create;
    let calls = 0;
    client.healthRecord.create = async (args: { data: Row }) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("unique"), { code: "P2002" });
      return original(args);
    };
    await saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now);
    expect(calls).toBe(2);
    expect(state.records).toHaveLength(1);

    resetState();
    client.healthRecord.create = async () => {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    };
    await expect(saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now)).rejects.toMatchObject({ code: "CONFLICT" });
    client.healthRecord.create = original;
  });
});

describe("the neutral health note marker", () => {
  beforeEach(resetState);

  it("returns ids only, for rows with a note, and nothing when the feature is off", async () => {
    await saveHealthRecord(leader, "club-a", "member-1", syntheticRecord, now);
    expect(await healthNoteFlagsForRoster("club-a", ["member-1", "member-2"])).toEqual({ "member-1": true });
    state.env.HEALTH_RECORDS_ENABLED = false;
    expect(await healthNoteFlagsForRoster("club-a", ["member-1"])).toEqual({});
  });
});
