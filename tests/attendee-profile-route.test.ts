import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  getCurrentAttendee: vi.fn(),
  accountNeedsSecondStep: vi.fn(),
  getAttendeeProfile: vi.fn(),
  updateAttendeeProfile: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/return-redirect", () => ({ twoStepRedirectPath: vi.fn() }));
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: mocks.accountNeedsSecondStep }));
vi.mock("@/modules/attendee-accounts/profile-service", async () => {
  const actual = await vi.importActual<typeof import("@/modules/attendee-accounts/profile-service")>(
    "@/modules/attendee-accounts/profile-service",
  );
  return {
    attendeeProfileSchema: actual.attendeeProfileSchema,
    getAttendeeProfile: mocks.getAttendeeProfile,
    updateAttendeeProfile: mocks.updateAttendeeProfile,
  };
});

import { GET, PATCH } from "@/app/api/attendee/profile/route";

const profile = {
  firstName: "Avery",
  lastName: "Person",
  phone: "555-0100",
  shirtSize: "M",
  dietaryNeeds: "",
  accessibilityNeeds: "",
  mailingLine1: "1 Example Way",
  mailingLine2: "",
  mailingCity: "Sampletown",
  mailingRegion: "MI",
  mailingPostalCode: "49000",
  mailingCountry: "United States",
  emergencyContactName: "Casey Contact",
  emergencyContactRelationship: "Sibling",
  emergencyContactPhone: "555-0101",
};

function patchRequest(body: unknown = profile) {
  return new Request("https://events.imsda.test/api/attendee/profile", {
    method: "PATCH",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const getRequest = () => new Request("https://events.imsda.test/api/attendee/profile");
const callGet = () => (GET as unknown as (r: Request) => Promise<Response>)(getRequest());
const callPatch = (r: Request) => (PATCH as unknown as (r: Request) => Promise<Response>)(r);

function signedIn(via: "attendee" | "staff" = "attendee") {
  mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "acct-1" }, via, sessionId: "sess-1" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getAttendeeProfile.mockResolvedValue(profile);
  mocks.updateAttendeeProfile.mockResolvedValue(profile);
  mocks.accountNeedsSecondStep.mockResolvedValue("OK");
  signedIn();
});

// The route only reuses the shared gate's answer. Which roles produce a
// non-OK gate is proven against the real gate in
// attendee-profile-route-gate.test.ts.
describe("second step pending", () => {
  it.each(["VERIFY", "SETUP"])("refuses GET with no profile data (%s)", async (gate) => {
    mocks.accountNeedsSecondStep.mockResolvedValue(gate);
    const response = await callGet();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "SECOND_STEP_REQUIRED",
      message: "Finish two-step sign-in to manage your profile.",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(mocks.getAttendeeProfile).not.toHaveBeenCalled();
    expect(mocks.accountNeedsSecondStep).toHaveBeenCalledWith("acct-1", "sess-1");
  });

  it("refuses PATCH before parsing the body or saving anything", async () => {
    mocks.accountNeedsSecondStep.mockResolvedValue("VERIFY");
    const request = patchRequest();
    const parse = vi.spyOn(request, "json");
    const response = await callPatch(request);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("SECOND_STEP_REQUIRED");
    expect(parse).not.toHaveBeenCalled();
    expect(mocks.updateAttendeeProfile).not.toHaveBeenCalled();
  });
});

describe("cross-origin check", () => {
  it("stays first on PATCH", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(new Response(null, { status: 403 }));
    mocks.accountNeedsSecondStep.mockResolvedValue("VERIFY");
    const response = await callPatch(patchRequest());
    expect(response.status).toBe(403);
    expect(mocks.getCurrentAttendee).not.toHaveBeenCalled();
    expect(mocks.accountNeedsSecondStep).not.toHaveBeenCalled();
    expect(mocks.updateAttendeeProfile).not.toHaveBeenCalled();
  });
});

describe("accounts that may use the profile", () => {
  it("lets an account whose gate is OK GET and PATCH", async () => {
    const got = await callGet();
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ profile });
    const patched = await callPatch(patchRequest());
    expect(patched.status).toBe(200);
    expect(mocks.updateAttendeeProfile).toHaveBeenCalledWith("acct-1", profile);
  });

  it("still returns 400 for an invalid body", async () => {
    const response = await callPatch(patchRequest({ firstName: 1 }));
    expect(response.status).toBe(400);
    expect(mocks.updateAttendeeProfile).not.toHaveBeenCalled();
  });
});

describe("mailing address and emergency contact", () => {
  it("trims values and passes them through on PATCH", async () => {
    const response = await callPatch(patchRequest({
      ...profile,
      mailingCity: "  Sampletown  ",
      emergencyContactName: "  Casey Contact ",
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateAttendeeProfile).toHaveBeenCalledWith("acct-1", profile);
  });

  it("accepts empty strings, which clear the values", async () => {
    const cleared = {
      ...profile,
      mailingLine1: "", mailingCity: "", mailingRegion: "", mailingPostalCode: "", mailingCountry: "",
      emergencyContactName: "", emergencyContactRelationship: "", emergencyContactPhone: "",
    };
    const response = await callPatch(patchRequest(cleared));
    expect(response.status).toBe(200);
    expect(mocks.updateAttendeeProfile).toHaveBeenCalledWith("acct-1", cleared);
  });

  it("passes omitted fields to the service as undefined, meaning unchanged", async () => {
    const { firstName, lastName, phone, shirtSize, dietaryNeeds, accessibilityNeeds } = profile;
    const response = await callPatch(patchRequest({ firstName, lastName, phone, shirtSize, dietaryNeeds, accessibilityNeeds }));
    expect(response.status).toBe(200);
    const sent = mocks.updateAttendeeProfile.mock.calls[0]![1];
    expect(sent.mailingLine1).toBeUndefined();
    expect(sent.emergencyContactPhone).toBeUndefined();
    expect("mailingLine1" in sent).toBe(false);
  });

  it.each([
    ["an over-long address line", { mailingLine1: "x".repeat(201) }],
    ["an over-long emergency name", { emergencyContactName: "x".repeat(121) }],
    ["an over-long emergency phone", { emergencyContactPhone: "5".repeat(41) }],
    ["a non-text value", { mailingCity: 5 }],
    ["an unknown field", { mailingPlanet: "Mars" }],
  ])("rejects %s with 400 and saves nothing", async (_label, patch) => {
    const response = await callPatch(patchRequest({ ...profile, ...patch }));
    expect(response.status).toBe(400);
    expect(mocks.updateAttendeeProfile).not.toHaveBeenCalled();
  });

  it("returns the stored values on GET", async () => {
    const response = await callGet();
    expect((await response.json()).profile).toMatchObject({ mailingCity: "Sampletown", emergencyContactName: "Casey Contact" });
  });
});

describe("signed out or acting as", () => {
  it("returns 401 with no session", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    expect((await callGet()).status).toBe(401);
    expect((await callPatch(patchRequest())).status).toBe(401);
    expect(mocks.updateAttendeeProfile).not.toHaveBeenCalled();
  });

  it("keeps refusing staff act-as sessions", async () => {
    signedIn("staff");
    expect((await callGet()).status).toBe(401);
    expect((await callPatch(patchRequest())).status).toBe(401);
    expect(mocks.accountNeedsSecondStep).not.toHaveBeenCalled();
  });
});
