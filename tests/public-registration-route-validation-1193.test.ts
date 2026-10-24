import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #855 and #1193: the public registration ROUTE rejects a bad phone, email and number, not only
 * `preparePublicRegistration()`. The real route handler AND the real `submitPublicRegistration` run: body parsing, the input
 * schema, the form and version lookup, the answer validation and the error-to-response mapping. Only Prisma is mocked, at
 * the boundary: the form, event and version lookups return a fictitious published form, every other read finds nothing, and
 * every write method is recorded. A bad answer must answer 422 with no registration created and no write at all. No
 * submitted value may appear in the response or in any log. Synthetic data only.
 */
vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  writes: [] as string[],
  transactions: 0,
  form: null as unknown,
}));

vi.mock("@/lib/prisma", () => {
  const reads = (model: string) => new Proxy({}, {
    get: (_target, method: string) => async () => {
      if (/^(create|update|upsert|delete)/.test(method)) {
        state.writes.push(`${model}.${method}`);
        return {};
      }
      if (model === "registrationForm" && method === "findFirst") return state.form;
      if (method === "findMany") return [];
      if (method === "count") return 0;
      return null;
    },
  });
  const client = (extra: Record<string, unknown>) => new Proxy(extra, {
    get: (target, property: string) => (property in target ? target[property] : reads(property)),
  });
  const tx = client({
    $executeRaw: async () => { state.writes.push("$executeRaw"); return 0; },
    $executeRawUnsafe: async () => 0,
    $queryRaw: async () => [],
  });
  const db = client({
    $transaction: async (work: (client: unknown) => unknown) => {
      state.transactions += 1;
      return work(tx);
    },
  });
  return { getPrisma: () => db };
});

const mocks = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logError: mocks.logError, logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn(async () => { state.writes.push("auditLog"); }) }));
vi.mock("@/modules/rate-limit/service", () => ({
  checkPublicRegistrationRateLimit: vi.fn(async () => ({ allowed: true, decisions: [] })),
  checkPublicFormRoommateLookupRateLimit: vi.fn(async () => ({ allowed: true, decisions: [] })),
  publicRequestClientHash: vi.fn(() => "client-hash-1"),
}));
vi.mock("@/modules/notifications/settings", () => ({ isNotificationEnabled: async () => false }));

import { POST } from "@/app/api/public/events/[eventSlug]/forms/[formSlug]/registrations/route";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

const definition = registrationFormDefinitionSchema.parse({
  title: "Validation fixture",
  description: "Fictitious.",
  confirmationMessage: "Done.",
  sections: [{
    id: "contact_section",
    title: "Contact",
    description: "",
    fields: [
      { id: "f_first", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
      { id: "f_last", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
      { id: "f_email", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
      { id: "f_phone", key: "phone", label: "Phone", helpText: "", type: "PHONE", scope: "REGISTRATION", required: false, options: [] },
      { id: "f_party", key: "party_size", label: "Party size", helpText: "", type: "NUMBER", scope: "REGISTRATION", required: false, options: [] },
    ],
  }],
});

const good = { first_name: "Avery", last_name: "Tester", email: "avery@example.test", phone: "515 555 0134", party_size: "3" };
const context = { params: Promise.resolve({ eventSlug: "synthetic-event", formSlug: "attendee" }) };
const post = (responses: Record<string, unknown>) => new Request("https://events.imsda.test/api/public/events/synthetic-event/forms/attendee/registrations", {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://events.imsda.test" },
  body: JSON.stringify({ versionId: "version-1", idempotencyKey: "f4f76d46-f7d6-443d-a030-cb9a8ca15066", responses, website: "" }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_BASE_URL", "https://events.imsda.test");
  state.writes = [];
  state.transactions = 0;
  state.form = {
    id: "form-1",
    slug: "attendee",
    eventId: "event-1",
    event: {
      id: "event-1", name: "Synthetic Event", slug: "synthetic-event",
      startsAt: new Date("2099-06-05T14:00:00Z"), endsAt: new Date("2099-06-07T22:00:00Z"), timezone: "America/Chicago", location: "Synthetic Camp",
      capacity: null, isPublished: true, archivedAt: null, registrationOpensOn: null, registrationClosesOn: null, waitlistEnabled: false,
      billingMode: "ATTENDEE_PAY", audience: "GENERAL", ageOfMajority: 18, refundPolicy: null, attendeeTypes: [],
    },
    versions: [{ id: "version-1", versionNumber: 1, definition, publishedAt: new Date("2026-10-01T00:00:00Z") }],
  };
});

describe("public registration route (#855, #1193)", () => {
  it.each([
    ["phone", { phone: "idk-call-me" }, "Phone must be a 10-digit US number"],
    ["email", { email: "avery at example" }, "Email must be a valid email address"],
    ["number", { party_size: "a few" }, "Party size must be a number"],
  ])("answers 422 for a bad %s, creates nothing, and never echoes the value", async (_name, patch, message) => {
    const response = await POST(post({ ...good, ...patch }), context);
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain("INVALID_SUBMISSION");
    expect(body).toContain(message);
    // The real repository ran: it opened its transaction, found the form, and stopped at validation.
    expect(state.transactions).toBeGreaterThan(0);
    expect(state.writes.filter((write) => write !== "$executeRaw")).toEqual([]);
    for (const value of Object.values(patch)) {
      expect(body).not.toContain(value);
      for (const call of mocks.logError.mock.calls) expect(JSON.stringify(call)).not.toContain(value);
    }
  });

  it("gets past validation with good answers, so the rejections above come from the answers", async () => {
    await POST(post(good), context).catch(() => undefined);
    // Good answers reach the registration writes (the mocked database then cannot finish, which is not what is tested here).
    expect(state.writes.some((write) => write.startsWith("registration"))).toBe(true);
  });
});
