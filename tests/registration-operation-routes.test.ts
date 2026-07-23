import { beforeEach, describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getCurrentSession: vi.fn(),
}));
const operationMocks = vi.hoisted(() => ({
  transferRegistration: vi.fn(),
  substituteRegistrationAttendee: vi.fn(),
}));
const messageMocks = vi.hoisted(() => ({
  ensureEventMessagingDefaults: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
}));
const privateAccessMocks = vi.hoisted(() => ({
  createStableRegistrationAccessToken: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/authorization", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/modules/access/authorization")
  >();
  return { ...actual, requirePermission: accessMocks.requirePermission };
});
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: accessMocks.getCurrentSession,
}));
vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: vi.fn(),
}));
vi.mock("@/modules/registrations/operations-repository", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/modules/registrations/operations-repository")
  >();
  return {
    ...actual,
    transferRegistration: operationMocks.transferRegistration,
    substituteRegistrationAttendee:
      operationMocks.substituteRegistrationAttendee,
  };
});
vi.mock("@/modules/communications/messaging-repository", () => ({
  ensureEventMessagingDefaults:
    messageMocks.ensureEventMessagingDefaults,
  processQueuedMessageIdsAfterCommit:
    messageMocks.processQueuedMessageIdsAfterCommit,
}));
vi.mock("@/modules/public-access/repository", () => ({
  createStableRegistrationAccessToken:
    privateAccessMocks.createStableRegistrationAccessToken,
}));

import { POST as transferPOST } from "@/app/api/events/[eventId]/registrations/[registrationId]/transfer/route";
import { POST as substitutionPOST } from "@/app/api/events/[eventId]/registrations/[registrationId]/attendees/[attendeeId]/substitution/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import { RegistrationOperationError } from "@/modules/registrations/operations-repository";

const transferBody = {
  clientRequestId: "1616c563-e266-44b4-8c9a-d77e88ac3923",
  firstName: "Morgan",
  lastName: "Lee",
  email: "morgan@example.test",
  phone: "555-0102",
  reason: "Family requested the transfer.",
};

const responseSnapshot = {
  registration: {
    id: "registration-1",
    confirmationCode: "REG-123",
  },
  operation: {
    id: "operation-1",
    type: "TRANSFER",
    createdAt: "2026-07-23T16:00:00.000Z",
    noticeMessageIds: ["message-new", "message-prior"],
    noticeRecipients: [
      { role: "NEW_CONTACT", email: "morgan@example.test" },
    ],
    deliveryMode: "LOCAL_CAPTURE",
  },
};

function request(
  pathname: string,
  body: Record<string, unknown>,
  options: { origin?: string; contentType?: string } = {},
) {
  return new Request(`https://events.imsda.test${pathname}`, {
    method: "POST",
    headers: {
      Origin: options.origin ?? "https://events.imsda.test",
      ...(options.contentType === undefined
        ? { "Content-Type": "application/json; charset=utf-8" }
        : options.contentType
          ? { "Content-Type": options.contentType }
          : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.getCurrentSession.mockResolvedValue({
    user: { id: "user-1", displayName: "Staff User" },
  });
  accessMocks.requirePermission.mockResolvedValue({
    user: {
      id: "user-1",
      displayName: "Staff User",
      email: "staff@example.test",
    },
  });
  operationMocks.transferRegistration.mockResolvedValue({
    response: responseSnapshot,
    pendingMessageIds: ["message-new", "message-prior"],
  });
  operationMocks.substituteRegistrationAttendee.mockResolvedValue({
    response: {
      ...responseSnapshot,
      operation: {
        ...responseSnapshot.operation,
        type: "ATTENDEE_SUBSTITUTION",
        noticeMessageIds: ["message-substitution"],
      },
    },
    pendingMessageIds: ["message-substitution"],
  });
  privateAccessMocks.createStableRegistrationAccessToken.mockResolvedValue({
    token: "private-secret-never-returned",
    tokenRecordId: "access-1",
    managePath: "/manage/private-secret-never-returned",
    expiresAt: new Date("2026-12-01T00:00:00.000Z"),
  });
  messageMocks.ensureEventMessagingDefaults.mockResolvedValue(undefined);
  messageMocks.processQueuedMessageIdsAfterCommit.mockResolvedValue({});
});

describe("staff registration operation routes", () => {
  it("requires same-origin application/json before starting a transfer", async () => {
    const crossOrigin = await transferPOST(
      request(
        "/api/events/event-1/registrations/registration-1/transfer",
        transferBody,
        { origin: "https://attacker.example" },
      ),
      { params: Promise.resolve({
        eventId: "event-1",
        registrationId: "registration-1",
      }) },
    );
    const wrongMedia = await transferPOST(
      request(
        "/api/events/event-1/registrations/registration-1/transfer",
        transferBody,
        { contentType: "text/plain" },
      ),
      { params: Promise.resolve({
        eventId: "event-1",
        registrationId: "registration-1",
      }) },
    );

    expect(crossOrigin.status).toBe(403);
    expect(wrongMedia.status).toBe(415);
    expect(operationMocks.transferRegistration).not.toHaveBeenCalled();
  });

  it("authorizes, commits, issues private access post-commit, then processes notices without exposing the token", async () => {
    const response = await transferPOST(
      request(
        "/api/events/event-1/registrations/registration-1/transfer",
        transferBody,
      ),
      { params: Promise.resolve({
        eventId: "event-1",
        registrationId: "registration-1",
      }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(accessMocks.requirePermission).toHaveBeenCalledWith(
      expect.anything(),
      "event-1",
      "MANAGE_REGISTRATION",
      expect.any(Function),
    );
    expect(operationMocks.transferRegistration).toHaveBeenCalledWith(
      "event-1",
      "registration-1",
      transferBody,
      { id: "user-1", displayName: "Staff User" },
    );
    expect(messageMocks.ensureEventMessagingDefaults)
      .toHaveBeenCalledWith("event-1");
    expect(messageMocks.ensureEventMessagingDefaults.mock.invocationCallOrder[0])
      .toBeLessThan(
        operationMocks.transferRegistration.mock.invocationCallOrder[0]!,
      );
    expect(privateAccessMocks.createStableRegistrationAccessToken)
      .toHaveBeenCalledWith({
        registrationId: "registration-1",
        deliveryKey: "message:message-new",
      });
    expect(operationMocks.transferRegistration.mock.invocationCallOrder[0])
      .toBeLessThan(
        privateAccessMocks.createStableRegistrationAccessToken
          .mock.invocationCallOrder[0]!,
      );
    expect(messageMocks.processQueuedMessageIdsAfterCommit)
      .toHaveBeenCalledWith(["message-new", "message-prior"]);
    expect(body).toEqual(responseSnapshot);
    expect(JSON.stringify(body)).not.toContain("private-secret");
  });

  it("uses a strict schema and rejects unknown transfer fields", async () => {
    const response = await transferPOST(
      request(
        "/api/events/event-1/registrations/registration-1/transfer",
        { ...transferBody, totalAmountCents: 0 },
      ),
      { params: Promise.resolve({
        eventId: "event-1",
        registrationId: "registration-1",
      }) },
    );

    expect(response.status).toBe(400);
    expect(operationMocks.transferRegistration).not.toHaveBeenCalled();
  });

  it("scopes substitutions to the attendee and never rotates registration access", async () => {
    const response = await substitutionPOST(
      request(
        "/api/events/event-1/registrations/registration-1/attendees/attendee-1/substitution",
        { ...transferBody, email: "" },
      ),
      { params: Promise.resolve({
        eventId: "event-1",
        registrationId: "registration-1",
        attendeeId: "attendee-1",
      }) },
    );

    expect(response.status).toBe(200);
    expect(operationMocks.substituteRegistrationAttendee).toHaveBeenCalledWith(
      "event-1",
      "registration-1",
      "attendee-1",
      { ...transferBody, email: "" },
      { id: "user-1", displayName: "Staff User" },
    );
    expect(privateAccessMocks.createStableRegistrationAccessToken)
      .not.toHaveBeenCalled();
    expect(messageMocks.processQueuedMessageIdsAfterCommit)
      .toHaveBeenCalledWith(["message-substitution"]);
  });

  it("maps checked-in and authorization failures without processing notices", async () => {
    operationMocks.substituteRegistrationAttendee.mockRejectedValueOnce(
      new RegistrationOperationError(
        "ATTENDEE_CHECKED_IN",
        "Undo the check-in first.",
      ),
    );
    const checkedIn = await substitutionPOST(
      request(
        "/api/events/event-1/registrations/registration-1/attendees/attendee-1/substitution",
        { ...transferBody, email: "" },
      ),
      { params: Promise.resolve({
        eventId: "event-1",
        registrationId: "registration-1",
        attendeeId: "attendee-1",
      }) },
    );
    accessMocks.requirePermission.mockRejectedValueOnce(
      new AccessDeniedError(
        "Permission required.",
        403,
        "PERMISSION_DENIED",
      ),
    );
    const denied = await transferPOST(
      request(
        "/api/events/event-1/registrations/registration-1/transfer",
        transferBody,
      ),
      { params: Promise.resolve({
        eventId: "event-1",
        registrationId: "registration-1",
      }) },
    );

    expect(checkedIn.status).toBe(409);
    expect(await checkedIn.json()).toMatchObject({
      error: "ATTENDEE_CHECKED_IN",
    });
    expect(denied.status).toBe(403);
    expect(messageMocks.processQueuedMessageIdsAfterCommit)
      .not.toHaveBeenCalled();
  });
});
