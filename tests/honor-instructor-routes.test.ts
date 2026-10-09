import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  getCurrentAttendee: vi.fn(),
  requireHonorPermission: vi.fn(),
  getInstructorRoster: vi.fn(),
  markInstructorClass: vi.fn(),
  acceptInstructorInvite: vi.fn(),
  inviteHonorInstructor: vi.fn(),
  listHonorInstructors: vi.fn(),
  setHonorInstructorClasses: vi.fn(),
  removeHonorInstructor: vi.fn(),
  resendHonorInstructorInvite: vi.fn(),
  attendeeSecondStepPending: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/portal-second-step", () => ({ attendeeSecondStepPending: mocks.attendeeSecondStepPending }));
vi.mock("@/modules/honors/access", () => ({ requireHonorPermission: mocks.requireHonorPermission }));
vi.mock("@/modules/honors/instructor-repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/honors/instructor-repository")>("@/modules/honors/instructor-repository");
  return {
    ...actual,
    getInstructorRoster: mocks.getInstructorRoster,
    markInstructorClass: mocks.markInstructorClass,
    acceptInstructorInvite: mocks.acceptInstructorInvite,
    inviteHonorInstructor: mocks.inviteHonorInstructor,
    listHonorInstructors: mocks.listHonorInstructors,
    setHonorInstructorClasses: mocks.setHonorInstructorClasses,
    removeHonorInstructor: mocks.removeHonorInstructor,
    resendHonorInstructorInvite: mocks.resendHonorInstructorInvite,
  };
});

import { POST as accept } from "@/app/api/attendee/honor-instructor/invites/[instructorId]/accept/route";
import { GET as roster } from "@/app/api/attendee/honor-instructor/classes/[offeringId]/route";
import { POST as marks } from "@/app/api/attendee/honor-instructor/classes/[offeringId]/marks/route";
import { GET as staffList, POST as staffInvite } from "@/app/api/events/[eventId]/honors/instructors/route";
import { PATCH as staffClasses, DELETE as staffRemove } from "@/app/api/events/[eventId]/honors/instructors/[instructorId]/route";
import { POST as staffResend } from "@/app/api/events/[eventId]/honors/instructors/[instructorId]/resend/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { HonorInstructorError } from "@/modules/honors/instructor-repository";
import { STERLING_REQUIRED_MESSAGE } from "@/modules/honors/instructor-domain";

const classContext = { params: Promise.resolve({ offeringId: "off-1" }) };
const inviteContext = { params: Promise.resolve({ instructorId: "ins-1" }) };
const eventContext = { params: Promise.resolve({ eventId: "site-b" }) };
const staffInstructorContext = { params: Promise.resolve({ eventId: "site-b", instructorId: "ins-1" }) };

function post(body: unknown) {
  return new Request("https://events.imsda.test/api/x", {
    method: "POST",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const get = () => new Request("https://events.imsda.test/api/x");

const header = { offeringId: "off-1", honorName: "Knots", session: "Session 1", room: "", eventName: "Sample Weekend", editable: true, editDeadline: "2026-10-25T00:00:00.000Z", editGraceDays: 14 };
const rows = [{ enrollmentId: "enr-1", firstName: "Ada", lastName: "Sample", clubName: "Sample Club", attended: false, completed: false, recorded: false, recordedVoided: false }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "acct-1", verifiedEmail: "ins@example.test", displayName: "Ins" }, via: "attendee", sessionId: "s" });
  mocks.requireHonorPermission.mockResolvedValue({ user: { id: "staff-1" } });
  mocks.attendeeSecondStepPending.mockResolvedValue(false);
  mocks.getInstructorRoster.mockResolvedValue({ status: "OK", header, rows });
  mocks.markInstructorClass.mockResolvedValue({ view: { status: "OK", header, rows }, changed: 1, locked: 0, writeBack: null });
});

describe("instructor roster routes (#833)", () => {
  it("serves the roster from the signed-in account's own id, never a request value, with no caching", async () => {
    const response = await roster(get(), classContext);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getInstructorRoster).toHaveBeenCalledWith("acct-1", "off-1");
    expect(await response.json()).toEqual({ class: header, people: rows });
  });

  it("needs the person's own sign-in: signed out, or a staff member switched into the account, gets nothing", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    expect((await roster(get(), classContext)).status).toBe(401);
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "acct-1", verifiedEmail: "x@example.test", displayName: "S" }, via: "staff", sessionId: null });
    expect((await roster(get(), classContext)).status).toBe(401);
    expect((await marks(post({ action: "CLEAR" }), classContext)).status).toBe(401);
    expect(mocks.getInstructorRoster).not.toHaveBeenCalled();
    expect(mocks.markInstructorClass).not.toHaveBeenCalled();
  });

  it("requires the club second step like club roles do: roster, marks and accepting are refused until it is passed", async () => {
    mocks.attendeeSecondStepPending.mockResolvedValue(true);
    expect((await roster(get(), classContext)).status).toBe(403);
    expect((await marks(post({ action: "CLEAR" }), classContext)).status).toBe(403);
    expect((await accept(post({}), inviteContext)).status).toBe(403);
    expect(mocks.getInstructorRoster).not.toHaveBeenCalled();
    expect(mocks.markInstructorClass).not.toHaveBeenCalled();
    expect(mocks.acceptInstructorInvite).not.toHaveBeenCalled();
  });

  it("maps marks not open yet to 409", async () => {
    mocks.markInstructorClass.mockRejectedValue(new HonorInstructorError("MARKS_NOT_OPEN", "Marks open when the event starts."));
    const response = await marks(post({ action: "CLEAR" }), classContext);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "MARKS_NOT_OPEN" });
  });

  it("answers a class that isn't theirs with 404", async () => {
    mocks.getInstructorRoster.mockRejectedValue(new HonorInstructorError("NOT_ASSIGNED", "That class isn't one of yours."));
    const response = await roster(get(), classContext);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "NOT_ASSIGNED" });
  });

  it("answers a missing Sterling Volunteers check with 403, the clear message, and no names", async () => {
    mocks.getInstructorRoster.mockResolvedValue({ status: "STERLING_REQUIRED", header, message: STERLING_REQUIRED_MESSAGE });
    const response = await roster(get(), classContext);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({ error: "STERLING_REQUIRED", message: STERLING_REQUIRED_MESSAGE });
    expect(JSON.stringify(body)).not.toContain("Sample");
  });
});

describe("instructor marks route (#833)", () => {
  it("accepts one-click actions and per-person changes", async () => {
    for (const body of [{ action: "ALL_ATTENDED" }, { action: "ALL_COMPLETED" }, { action: "CLEAR" }, { action: "SET", enrollmentId: "enr-1", completed: true }]) {
      const response = await marks(post(body), classContext);
      expect(response.status).toBe(200);
      expect(mocks.markInstructorClass).toHaveBeenLastCalledWith("acct-1", "off-1", body);
    }
  });

  it("refuses anything else: unknown actions, extra keys, an empty change", async () => {
    for (const body of [{ action: "DELETE_ALL" }, { action: "CLEAR", accountId: "acct-2" }, { action: "SET", enrollmentId: "enr-1" }, { action: "SET", completed: true }, {}]) {
      expect((await marks(post(body), classContext)).status).toBe(400);
    }
    expect(mocks.markInstructorClass).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin post", async () => {
    mocks.rejectCrossOriginRequest.mockReturnValue(new Response("no", { status: 403 }));
    expect((await marks(post({ action: "CLEAR" }), classContext)).status).toBe(403);
    expect(mocks.markInstructorClass).not.toHaveBeenCalled();
  });

  it("maps the repository's refusals", async () => {
    mocks.markInstructorClass.mockRejectedValue(new HonorInstructorError("MARKS_CLOSED", "closed"));
    expect((await marks(post({ action: "CLEAR" }), classContext)).status).toBe(409);
    mocks.markInstructorClass.mockRejectedValue(new HonorInstructorError("STERLING_REQUIRED", STERLING_REQUIRED_MESSAGE));
    expect((await marks(post({ action: "CLEAR" }), classContext)).status).toBe(403);
    mocks.markInstructorClass.mockRejectedValue(new HonorInstructorError("NOT_ASSIGNED", "no"));
    expect((await marks(post({ action: "CLEAR" }), classContext)).status).toBe(404);
  });
});

describe("accepting an invite (#833)", () => {
  it("passes the signed-in account's own id and verified email", async () => {
    mocks.acceptInstructorInvite.mockResolvedValue({ instructorId: "ins-1" });
    const response = await accept(post({}), inviteContext);
    expect(response.status).toBe(200);
    expect(mocks.acceptInstructorInvite).toHaveBeenCalledWith("ins-1", { id: "acct-1", verifiedEmail: "ins@example.test" });
  });

  it("refuses an invite sent to another address", async () => {
    mocks.acceptInstructorInvite.mockRejectedValue(new HonorInstructorError("INVITE_EMAIL_MISMATCH", "different address"));
    expect((await accept(post({}), inviteContext)).status).toBe(403);
  });

  it("needs the person's own sign-in", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    expect((await accept(post({}), inviteContext)).status).toBe(401);
    expect(mocks.acceptInstructorInvite).not.toHaveBeenCalled();
  });
});

describe("staff instructor routes (#833)", () => {
  it("every one needs CONFIGURE_EVENT on this event and does nothing without it", async () => {
    mocks.requireHonorPermission.mockRejectedValue(new AccessDeniedError("nope", 403, "PERMISSION_DENIED"));
    const invite = { firstName: "Ada", lastName: "Sample", email: "ada@example.test", offeringIds: ["off-1"] };
    const responses = [
      await staffList(get(), eventContext),
      await staffInvite(post(invite), eventContext),
      await staffClasses(post({ offeringIds: ["off-1"] }), staffInstructorContext),
      await staffRemove(post({}), staffInstructorContext),
      await staffResend(post({}), staffInstructorContext),
    ];
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
    expect(mocks.inviteHonorInstructor).not.toHaveBeenCalled();
    expect(mocks.listHonorInstructors).not.toHaveBeenCalled();
    expect(mocks.setHonorInstructorClasses).not.toHaveBeenCalled();
    expect(mocks.removeHonorInstructor).not.toHaveBeenCalled();
    expect(mocks.resendHonorInstructorInvite).not.toHaveBeenCalled();
    expect(mocks.requireHonorPermission).toHaveBeenCalledWith("site-b");
  });

  it("invites with the staff member recorded", async () => {
    mocks.inviteHonorInstructor.mockResolvedValue({ instructorId: "ins-1", emailQueued: true });
    const invite = { firstName: "Ada", lastName: "Sample", email: "Ada@Example.test", offeringIds: ["off-1"] };
    const response = await staffInvite(post(invite), eventContext);
    expect(response.status).toBe(201);
    expect(mocks.inviteHonorInstructor).toHaveBeenCalledWith("site-b", { ...invite, email: "ada@example.test" }, "staff-1");
  });

  it("refuses an invite with no classes or an unknown field", async () => {
    expect((await staffInvite(post({ firstName: "A", lastName: "B", email: "a@example.test", offeringIds: [] }), eventContext)).status).toBe(400);
    expect((await staffInvite(post({ firstName: "A", lastName: "B", email: "a@example.test", offeringIds: ["x"], attendeeAccountId: "acct-9" }), eventContext)).status).toBe(400);
  });
});

describe("instructor read path never loads sensitive fields (#833)", () => {
  const source = readFileSync(path.join(process.cwd(), "modules/honors/instructor-repository.ts"), "utf8");
  const start = source.indexOf("const rosterEnrollmentSelect");
  const selectText = source.slice(start, source.indexOf("} satisfies Prisma.HonorEnrollmentSelect", start));

  it("selects names, club, marks and the honor-record link state only", () => {
    expect(start).toBeGreaterThan(0);
    for (const forbidden of ["profileSnapshot", "formResponses", "email", "phone", "birth", "guardian", "health", "dietary", "address", "emergency", "allerg"]) {
      expect(selectText.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(selectText).toContain("firstName");
    expect(selectText).toContain("lastName");
  });

  it("starts every account read from the account's own assignment", () => {
    expect(source).toContain("attendeeAccountId: accountId, acceptedAt: { not: null }, revokedAt: null");
    // Rosters and marks are only ever reached through `loadAssignment`.
    expect(source.match(/await loadAssignment\(accountId, offeringId\)/g)?.length).toBe(2);
  });
});
