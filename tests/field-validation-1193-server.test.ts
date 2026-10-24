/* eslint-disable @typescript-eslint/no-explicit-any -- loose in-memory stand-ins for the Prisma client */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1193: the server-side paths that moved onto the shared validators, with the real route handlers where there is one.
 * Each path rejects a changed bad value, leaves an unchanged old value alone by comparing with what is stored (never with a
 * flag the browser sent), and never puts the submitted value in its message or its log. Synthetic data only.
 */
const mocks = vi.hoisted(() => ({
  contacts: [] as Array<Record<string, any>>,
  settingsRow: null as Record<string, any> | null,
  storedSections: [] as Array<{ data: unknown }>,
  upsert: vi.fn(),
  sectionCreate: vi.fn(),
  sectionDelete: vi.fn(),
  contactCreate: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  getCurrentSession: vi.fn(),
  logError: vi.fn(),
}));

const db: any = {
  organization: { findFirst: vi.fn(async () => ({ id: "church-1" })) },
  organizationContact: {
    findFirst: vi.fn(async () => mocks.contacts[0] ?? null),
    updateMany: vi.fn(async () => ({ count: mocks.contacts.length })),
    create: mocks.contactCreate,
  },
  platformSettings: { findUnique: vi.fn(async () => mocks.settingsRow), upsert: mocks.upsert },
  eventContentSection: {
    findMany: vi.fn(async ({ where }: { where: { kind: string } }) => (where.kind === "CONTACT" ? mocks.storedSections : [])),
    deleteMany: mocks.sectionDelete,
    create: mocks.sectionCreate,
  },
  eventAsset: { findMany: vi.fn(async () => []) },
  auditLog: { create: vi.fn(async () => ({})) },
  user: { count: vi.fn(async () => 0) },
  $transaction: async (work: (tx: unknown) => unknown) => work(db),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => db }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logError: mocks.logError, logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));

import { PATCH as PLATFORM_PATCH } from "@/app/api/admin/platform-settings/route";
import { POST as PASTOR_POST } from "@/app/api/admin/organizations/[organizationId]/pastor-contact/route";
import { replaceEventContent } from "@/modules/events/content-repository";
import { setPastorContact } from "@/modules/organizations/contacts-repository";
import { pastorContactInputSchema } from "@/modules/organizations/contacts-schemas";
import { updatePlatformSettings, platformSettingsInputSchema } from "@/modules/system-admin/platform-settings";

const BAD_PHONE = "idk-call-me";
const GOOD_PHONE = "515 555 0134";
const STORED_PHONE = "(515) 555-0134";
const admin = { id: "admin-1", globalRole: "SYSTEM_ADMIN" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contacts = [];
  mocks.settingsRow = null;
  mocks.storedSections = [];
  mocks.contactCreate.mockResolvedValue({ id: "pastor-new" });
  mocks.requireSystemAdministrator.mockResolvedValue(admin);
  vi.stubEnv("APP_BASE_URL", "https://events.imsda.test");
});

// ---------------------------------------------------------------------------
describe("pastor contact phone (#1193)", () => {
  const set = (phone: string) => setPastorContact({ organizationId: "church-1", contact: pastorContactInputSchema.parse({ name: "Pat Pastor", phone }), actor: admin });

  it("rejects a new bad phone without echoing it, and writes nothing", async () => {
    const error = await set(BAD_PHONE).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_CONTACT" });
    expect((error as Error).message).toContain("Enter a 10-digit US number");
    expect((error as Error).message).not.toContain(BAD_PHONE);
    expect(mocks.contactCreate).not.toHaveBeenCalled();
  });

  it("stores a valid phone in one form", async () => {
    await set(GOOD_PHONE);
    expect(mocks.contactCreate.mock.calls[0][0].data.phone).toBe(STORED_PHONE);
  });

  it("keeps the active contact's old phone when it is sent back unchanged, but not for a different value", async () => {
    mocks.contacts = [{ id: "pastor-1", name: "Pat Pastor", email: null, phone: BAD_PHONE }];
    await expect(set(BAD_PHONE)).resolves.toMatchObject({ id: "pastor-1", replaced: false });
    await expect(set("also not a phone")).rejects.toMatchObject({ code: "INVALID_CONTACT" });
  });

  it("treats re-sending an old-format but valid phone as a retry, not a replacement with a duplicate history row", async () => {
    mocks.contacts = [{ id: "pastor-1", name: "Pat Pastor", email: null, phone: "515-555-0134" }];
    await expect(set(GOOD_PHONE)).resolves.toMatchObject({ id: "pastor-1", replaced: false });
    expect(mocks.contactCreate).not.toHaveBeenCalled();
    expect(db.organizationContact.updateMany).not.toHaveBeenCalled();
  });

  it("answers 400 on the real route, with a message that carries no phone", async () => {
    const response = await PASTOR_POST(
      new Request("https://events.imsda.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "set", contact: { name: "Pat", phone: BAD_PHONE } }) }),
      { params: Promise.resolve({ organizationId: "church-1" }) },
    );
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("INVALID_CONTACT");
    expect(body).not.toContain(BAD_PHONE);
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("invoice header phone (#1193)", () => {
  const input = (phone: string) => platformSettingsInputSchema.parse({ organizationName: "IMSDA", defaultTimezone: "America/Chicago", defaultAttendeeEditPolicy: "VERIFY_EVERY_EDIT", invoiceHeaderPhone: phone });
  const stored = (phone: string | null) => {
    mocks.settingsRow = { organizationName: "IMSDA", passkeyRpId: null, invoiceHeaderPhone: phone, defaultTimezone: "America/Chicago" };
    db.platformSettings.upsert = mocks.upsert.mockResolvedValue({});
  };

  it("rejects a new bad phone without echoing it, and stores a valid one in one form", async () => {
    stored(null);
    const error = await updatePlatformSettings(input(BAD_PHONE), "admin-1").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_SETTING" });
    expect((error as Error).message).not.toContain(BAD_PHONE);
    expect(mocks.upsert).not.toHaveBeenCalled();
    await updatePlatformSettings(input(GOOD_PHONE), "admin-1").catch(() => undefined);
    expect(mocks.upsert.mock.calls[0]?.[0].update.invoiceHeaderPhone).toBe(STORED_PHONE);
  });

  it("leaves the stored phone alone when it is sent back unchanged, and rejects any other bad value", async () => {
    stored("555-0100");
    await updatePlatformSettings(input("555-0100"), "admin-1").catch(() => undefined);
    expect(mocks.upsert.mock.calls[0]?.[0].update.invoiceHeaderPhone).toBe("555-0100");
    mocks.upsert.mockClear();
    await expect(updatePlatformSettings(input("555-0199"), "admin-1")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("answers 400 on the real route, with a message that carries no phone", async () => {
    mocks.getCurrentSession.mockResolvedValue({ user: { id: "admin-1", globalRole: "SYSTEM_ADMIN" } });
    stored(null);
    const response = await PLATFORM_PATCH(new Request("https://events.imsda.test/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationName: "IMSDA", defaultTimezone: "America/Chicago", defaultAttendeeEditPolicy: "VERIFY_EVERY_EDIT", invoiceHeaderPhone: BAD_PHONE }),
    }));
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("INVALID_SETTING");
    expect(body).not.toContain(BAD_PHONE);
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("event contact block save (#1193)", () => {
  const contactSection = (...contacts: Array<{ name: string; phone: string }>) => ({
    kind: "CONTACT" as const,
    title: "Contact us",
    body: "",
    placement: "PUBLIC_PAGE" as const,
    items: [],
    isPublished: true,
    links: [],
    data: { contacts: contacts.map((contact) => ({ role: "", email: "", ...contact })) },
  });
  const save = (...contacts: Array<{ name: string; phone: string }>) => replaceEventContent("event_1", { sections: [contactSection(...contacts)] } as never, "user_1");

  it("rejects a new bad phone, names the contact's position and not the value, and writes nothing", async () => {
    const error = await save({ name: "Sam Example", phone: BAD_PHONE }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_CONTACT" });
    expect((error as Error).message).toMatch(/^Contact 1: Enter a 10-digit US number/);
    expect(JSON.stringify(error)).not.toContain(BAD_PHONE);
    expect(mocks.sectionDelete).not.toHaveBeenCalled();
    expect(mocks.sectionCreate).not.toHaveBeenCalled();
  });

  it("stores a valid phone in one form", async () => {
    await save({ name: "Sam Example", phone: GOOD_PHONE });
    expect(mocks.sectionCreate.mock.calls[0][0].data.data.contacts[0].phone).toBe(STORED_PHONE);
  });

  it("saves the page again when an old contact phone is stored for that contact, and rejects the same text for a new one", async () => {
    mocks.storedSections = [{ data: { contacts: [{ name: "Sam Example", role: "", email: "", phone: "555-0100" }] } }];
    await save({ name: "Sam Example", phone: "555-0100" });
    expect(mocks.sectionCreate.mock.calls[0][0].data.data.contacts[0].phone).toBe("555-0100");
    mocks.sectionCreate.mockClear();
    await expect(save({ name: "Sam Example", phone: "555-0100" }, { name: "New Person", phone: "555-0100" })).rejects.toMatchObject({ code: "INVALID_CONTACT" });
    expect(mocks.sectionCreate).not.toHaveBeenCalled();
  });
});
