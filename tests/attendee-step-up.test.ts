import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  sealSecret: vi.fn(),
  openSecret: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/secret-box", () => ({
  sealSecret: dependencies.sealSecret,
  openSecret: dependencies.openSecret,
}));

import {
  attachAttendeeStepUpCode,
  consumeAttendeeEditStepUp,
  reuseAttendeeStepUpCode,
} from "@/modules/attendee-accounts/step-up-service";
import { hashOneTimeCode } from "@/modules/attendee-accounts/codes";

const NOW = new Date("2026-07-29T12:00:00Z");
const attendeeStepUpCode = {
  updateMany: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
};
const prisma = {
  attendeeStepUpCode,
  $transaction: vi.fn(async (
    operation: (tx: { attendeeStepUpCode: typeof attendeeStepUpCode }) => Promise<unknown>,
  ) => operation({ attendeeStepUpCode })),
};

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getPrisma.mockReturnValue(prisma);
  dependencies.sealSecret.mockReturnValue("sealed-code");
  dependencies.openSecret.mockReturnValue("246810");
  attendeeStepUpCode.updateMany.mockResolvedValue({ count: 1 });
});

describe("attendee edit step-up", () => {
  it("stores only the digest and sealed retry copy when delivery starts", async () => {
    await expect(attachAttendeeStepUpCode({
      accountId: "acct-1",
      messageId: "message-1",
      code: "246810",
      now: NOW,
    })).resolves.toBe(true);
    expect(attendeeStepUpCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          codeHash: hashOneTimeCode("246810"),
          sealedCode: "sealed-code",
        }),
      }),
    );
  });

  it("reuses the code only for the same outbox message", async () => {
    attendeeStepUpCode.findFirst.mockResolvedValue({ sealedCode: "sealed-code" });
    await expect(reuseAttendeeStepUpCode({
      accountId: "acct-1",
      messageId: "message-1",
      now: NOW,
    })).resolves.toBe("246810");
    expect(attendeeStepUpCode.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deliveryMessageId: "message-1" }),
      }),
    );
  });

  it("consumes a matching code for only the requesting session", async () => {
    attendeeStepUpCode.findFirst.mockResolvedValue({
      id: "step-1",
      codeHash: hashOneTimeCode("246810"),
      attempts: 0,
    });
    await expect(consumeAttendeeEditStepUp({
      accountId: "acct-1",
      sessionId: "session-1",
      code: "246810",
      now: NOW,
    })).resolves.toBe(true);
    expect(attendeeStepUpCode.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sessionId: "session-1" }),
      }),
    );
  });
});
