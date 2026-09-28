import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #555: every attendee route that changes security or account settings
 * refuses a staff email-bridge session (`via: "staff"`) and a signed-out
 * caller, and changes nothing.
 */

const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  beginPasskeyRegistration: vi.fn(),
  finishPasskeyRegistration: vi.fn(),
  beginPasskeyVerification: vi.fn(),
  removePasskey: vi.fn(),
  markRosterUnlocked: vi.fn(),
  updateAttendeeProfile: vi.fn(),
  getAttendeeProfile: vi.fn(),
  beginAttendeeEditStepUp: vi.fn(),
  checkStepUpRateLimit: vi.fn(),
  checkRosterUnlockRateLimit: vi.fn(),
  verifyAttendeeSecondFactor: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/club-rosters/access", () => ({ markRosterUnlocked: mocks.markRosterUnlocked }));
vi.mock("@/modules/rate-limit/service", () => ({
  checkAttendeeEditStepUpRateLimit: mocks.checkStepUpRateLimit,
  checkAttendeeRosterUnlockRateLimit: mocks.checkRosterUnlockRateLimit,
}));
vi.mock("@/modules/attendee-accounts/passkeys", async () => {
  const actual = await vi.importActual<typeof import("@/modules/attendee-accounts/passkeys")>("@/modules/attendee-accounts/passkeys");
  return {
    ...actual,
    beginPasskeyRegistration: mocks.beginPasskeyRegistration,
    finishPasskeyRegistration: mocks.finishPasskeyRegistration,
    beginPasskeyVerification: mocks.beginPasskeyVerification,
    removePasskey: mocks.removePasskey,
  };
});
vi.mock("@/modules/attendee-accounts/profile-service", async () => {
  const actual = await vi.importActual<typeof import("@/modules/attendee-accounts/profile-service")>("@/modules/attendee-accounts/profile-service");
  return { ...actual, getAttendeeProfile: mocks.getAttendeeProfile, updateAttendeeProfile: mocks.updateAttendeeProfile };
});
vi.mock("@/modules/attendee-accounts/step-up-service", () => ({
  beginAttendeeEditStepUp: mocks.beginAttendeeEditStepUp,
  bindAttendeeStepUpMessage: vi.fn(),
}));
vi.mock("@/modules/attendee-accounts/attendee-email-dispatch", () => ({
  queueAttendeeEditVerificationEmail: vi.fn(),
  deliverQueuedAttendeeEmail: vi.fn(),
}));
vi.mock("@/modules/attendee-accounts/attendee-email", () => ({ mintAttendeeCodeWithoutSending: vi.fn() }));
vi.mock("@/modules/attendee-accounts/mfa-service", async () => {
  const actual = await vi.importActual<typeof import("@/modules/attendee-accounts/mfa-service")>("@/modules/attendee-accounts/mfa-service");
  return { ...actual, verifyAttendeeSecondFactor: mocks.verifyAttendeeSecondFactor };
});
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: vi.fn() };
});

import { POST as REGISTRATION_OPTIONS } from "@/app/api/attendee/passkeys/registration/options/route";
import { POST as REGISTRATION } from "@/app/api/attendee/passkeys/registration/route";
import { POST as VERIFICATION_OPTIONS } from "@/app/api/attendee/passkeys/verification/options/route";
import { DELETE as REMOVE_PASSKEY } from "@/app/api/attendee/passkeys/[passkeyId]/route";
import { GET as PROFILE_GET, PATCH as PROFILE_PATCH } from "@/app/api/attendee/profile/route";
import { POST as STEP_UP } from "@/app/api/attendee/step-up/route";
import { POST as ROSTER_UNLOCK } from "@/app/api/attendee/roster-unlock/route";

const account = { id: "account-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const url = "https://events.imsda.test/api/attendee/x";
const json = (method: string, body: unknown = {}) => new Request(url, {
  method,
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: method === "GET" ? undefined : JSON.stringify(body),
});
const passkeyContext = { params: Promise.resolve({ passkeyId: "passkey-1" }) };

const routes: Array<[string, () => Promise<Response>]> = [
  ["passkey registration options", () => REGISTRATION_OPTIONS(json("POST"))],
  ["passkey registration", () => REGISTRATION(json("POST", { response: {}, name: "Key" }))],
  ["passkey verification options", () => VERIFICATION_OPTIONS(json("POST"))],
  ["passkey removal", () => REMOVE_PASSKEY(json("DELETE"), passkeyContext)],
  ["profile read", () => PROFILE_GET(json("GET"))],
  ["profile update", () => PROFILE_PATCH(json("PATCH", { displayName: "Someone Else" }))],
  ["edit step-up code", () => STEP_UP(json("POST"))],
  ["roster unlock", () => ROSTER_UNLOCK(json("POST", { code: "123456" }))],
];

function expectNothingChanged() {
  for (const key of [
    "beginPasskeyRegistration", "finishPasskeyRegistration", "beginPasskeyVerification", "removePasskey",
    "markRosterUnlocked", "updateAttendeeProfile", "getAttendeeProfile", "beginAttendeeEditStepUp",
    "verifyAttendeeSecondFactor",
  ] as const) {
    expect(mocks[key], key).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkStepUpRateLimit.mockResolvedValue({ allowed: true, decisions: [] });
  mocks.checkRosterUnlockRateLimit.mockResolvedValue({ allowed: true, decisions: [] });
});

describe.each([
  ["a staff email-bridge session", { account, via: "staff", sessionId: null }],
  ["a signed-out caller", { account: null, via: null, sessionId: null }],
])("%s", (_label, current) => {
  beforeEach(() => mocks.getCurrentAttendee.mockResolvedValue(current));

  it.each(routes)("is refused by %s with 401 and no state change", async (_name, call) => {
    expect((await call()).status).toBe(401);
    expectNothingChanged();
  });
});
