import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #555: every attendee two-step action needs the person's own attendee
 * session. A staff session that reaches the account through the email bridge
 * (`via: "staff"`) must be refused before anything is read or changed.
 */

const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  markRosterUnlocked: vi.fn(),
  checkRateLimit: vi.fn(),
  getStatus: vi.fn(),
  begin: vi.fn(),
  confirm: vi.fn(),
  disable: vi.fn(),
  regenerate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  getCurrentAttendee: mocks.getCurrentAttendee,
}));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/club-rosters/access", () => ({ markRosterUnlocked: mocks.markRosterUnlocked }));
vi.mock("@/modules/rate-limit/service", () => ({
  checkAttendeeRosterUnlockRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/modules/attendee-accounts/mfa-service", async () => {
  const actual = await vi.importActual<typeof import("@/modules/attendee-accounts/mfa-service")>(
    "@/modules/attendee-accounts/mfa-service",
  );
  return {
    ...actual,
    getAttendeeMfaStatus: mocks.getStatus,
    beginAttendeeMfaEnrollment: mocks.begin,
    confirmAttendeeMfaEnrollment: mocks.confirm,
    disableAttendeeMfa: mocks.disable,
    regenerateAttendeeRecoveryCodes: mocks.regenerate,
  };
});

import { GET, POST } from "@/app/api/attendee/mfa/route";

const account = { id: "account-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const status = { enrolled: false };

const get = () => new Request("https://events.imsda.test/api/attendee/mfa");

function post(body: Record<string, unknown>) {
  return new Request("https://events.imsda.test/api/attendee/mfa", {
    method: "POST",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const actions: Array<[string, Record<string, unknown>]> = [
  ["begin", { action: "begin" }],
  ["confirm", { action: "confirm", code: "123456" }],
  ["disable", { action: "disable", code: "123456" }],
];

function expectNoStateChange() {
  expect(mocks.begin).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.disable).not.toHaveBeenCalled();
  expect(mocks.regenerate).not.toHaveBeenCalled();
  expect(mocks.markRosterUnlocked).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, decisions: [] });
  mocks.getStatus.mockResolvedValue(status);
  mocks.begin.mockResolvedValue({ otpauthUri: "otpauth://totp/example" });
  mocks.confirm.mockResolvedValue({ recoveryCodes: [] });
  mocks.disable.mockResolvedValue(undefined);
  mocks.regenerate.mockResolvedValue({ recoveryCodes: [] });
});

describe("/api/attendee/mfa own-session rule", () => {
  describe("a staff email-bridge session", () => {
    beforeEach(() => {
      mocks.getCurrentAttendee.mockResolvedValue({ account, via: "staff", sessionId: null });
    });

    it("cannot read MFA status", async () => {
      const response = await GET(get());
      expect(response.status).toBe(401);
      expect((await response.json()).error).toBe("OWN_SESSION_REQUIRED");
      expect(mocks.getStatus).not.toHaveBeenCalled();
    });

    it.each(actions)("cannot %s", async (_name, body) => {
      const response = await POST(post(body));
      expect(response.status).toBe(401);
      expect((await response.json()).error).toBe("OWN_SESSION_REQUIRED");
      expectNoStateChange();
    });

    it.each([
      ["without a code", { action: "regenerate-recovery-codes" }],
      ["with a code", { action: "regenerate-recovery-codes", code: "123456" }],
    ])("cannot mint recovery codes %s, and spends no rate-limit budget", async (_name, body) => {
      const response = await POST(post(body));
      expect(response.status).toBe(401);
      expect((await response.json()).error).toBe("OWN_SESSION_REQUIRED");
      expect(mocks.regenerate).not.toHaveBeenCalled();
      expect(mocks.checkRateLimit).not.toHaveBeenCalled();
      expectNoStateChange();
    });
  });

  describe("the attendee's own session", () => {
    it("reads status", async () => {
      const response = await GET(get());
      expect(response.status).toBe(200);
      expect(mocks.getStatus).toHaveBeenCalledWith("account-1");
    });

    it("begins enrollment", async () => {
      expect((await POST(post({ action: "begin" }))).status).toBe(200);
      expect(mocks.begin).toHaveBeenCalledWith("account-1");
    });

    it("confirms enrollment and marks the session verified", async () => {
      expect((await POST(post({ action: "confirm", code: "123 456" }))).status).toBe(200);
      expect(mocks.confirm).toHaveBeenCalledWith("account-1", "123456");
      expect(mocks.markRosterUnlocked).toHaveBeenCalledWith("session-1");
    });

    it("disables MFA", async () => {
      expect((await POST(post({ action: "disable", code: "123456" }))).status).toBe(200);
      expect(mocks.disable).toHaveBeenCalledWith("account-1", "123456");
    });

    it("regenerates recovery codes", async () => {
      expect((await POST(post({ action: "regenerate-recovery-codes" }))).status).toBe(200);
      expect(mocks.regenerate).toHaveBeenCalledWith("account-1", { sessionId: "session-1", code: null });
    });
  });

  describe("signed out", () => {
    beforeEach(() => {
      mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    });

    it("gets 401 on GET", async () => {
      expect((await GET(get())).status).toBe(401);
      expect(mocks.getStatus).not.toHaveBeenCalled();
    });

    it.each([...actions, ["regenerate-recovery-codes", { action: "regenerate-recovery-codes" }] as [string, Record<string, unknown>]])(
      "gets 401 on %s",
      async (_name, body) => {
        expect((await POST(post(body))).status).toBe(401);
        expectNoStateChange();
      },
    );
  });
});
