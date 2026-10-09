import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ squareHostedCheckout: { findUnique: mocks.findUnique } }),
}));
vi.mock("@/modules/rate-limit/service", () => ({ checkPublicPaymentStatusRateLimit: mocks.rateLimit }));

import { hashOpaqueToken } from "@/modules/access/tokens";
import {
  hostedReturnMessage,
  maskConfirmationCode,
} from "@/modules/payments/hosted-return-presentation";
import { getHostedReturnStatus } from "@/modules/payments/square-hosted-return";
import { GET } from "@/app/api/public/square-return/[returnId]/route";

type Handler = (request: Request, context: unknown) => Promise<Response>;
const get = GET as unknown as Handler;
const returnId = "R".repeat(43);
const now = new Date("2026-10-10T12:00:00Z");

function row(overrides: Record<string, unknown> = {}) {
  return {
    returnExpiresAt: new Date("2026-10-20T12:00:00Z"),
    registration: { confirmationCode: "WR26-4417" },
    paymentAttempt: { status: "PROCESSING", duplicateReason: null, _count: { duplicateCharges: 0 } },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(row());
  mocks.rateLimit.mockResolvedValue({ allowed: true, decisions: [] });
});

describe("Square return status (#327)", () => {
  it("looks the id up by hash only, and shows a state and a masked code and nothing else", async () => {
    const status = await getHostedReturnStatus(returnId, { now });
    expect(status).toEqual({ state: "CONFIRMING", maskedConfirmationCode: "••••4417" });
    expect(mocks.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { returnTokenHash: hashOpaqueToken(returnId) },
    }));
    // Nothing that identifies a registrant, an amount or a way into the registration is selected.
    const select = JSON.stringify(mocks.findUnique.mock.calls[0]![0].select);
    expect(select).not.toMatch(/contactSnapshot|accountHolder|totalAmount|checkoutUrl|accessToken|payments/);
  });

  it("reports confirmed only from a succeeded attempt, and held for a duplicate or an exception", async () => {
    mocks.findUnique.mockResolvedValue(row({ paymentAttempt: { status: "SUCCEEDED", duplicateReason: null, _count: { duplicateCharges: 0 } } }));
    expect((await getHostedReturnStatus(returnId, { now }))?.state).toBe("CONFIRMED");
    mocks.findUnique.mockResolvedValue(row({ paymentAttempt: { status: "SUCCEEDED", duplicateReason: "BALANCE_ALREADY_PAID", _count: { duplicateCharges: 1 } } }));
    expect((await getHostedReturnStatus(returnId, { now }))?.state).toBe("HELD");
    mocks.findUnique.mockResolvedValue(row({ paymentAttempt: { status: "PROCESSING", duplicateReason: null, _count: { duplicateCharges: 2 } } }));
    expect((await getHostedReturnStatus(returnId, { now }))?.state).toBe("HELD");
  });

  it("is held whenever an exception is still open for the link, including a second payment on the order", async () => {
    // A settled, valid attempt with an open SECOND_PAYMENT_ON_ORDER record beside it.
    mocks.findUnique.mockResolvedValue(row({ paymentAttempt: { status: "SUCCEEDED", duplicateReason: null, _count: { duplicateCharges: 1 } } }));
    expect((await getHostedReturnStatus(returnId, { now }))?.state).toBe("HELD");
    // Only OPEN records are counted, so a resolved one does not hold the status.
    const select = JSON.stringify(mocks.findUnique.mock.calls.at(-1)![0].select);
    expect(select).toContain('"duplicateCharges":{"where":{"status":"OPEN"}}');
  });

  it("answers null for an unknown, expired or malformed id alike", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await getHostedReturnStatus(returnId, { now })).toBeNull();
    mocks.findUnique.mockResolvedValue(row({ returnExpiresAt: new Date("2026-10-10T12:00:00Z") }));
    expect(await getHostedReturnStatus(returnId, { now })).toBeNull();
    mocks.findUnique.mockResolvedValue(row({ returnExpiresAt: null }));
    expect(await getHostedReturnStatus(returnId, { now })).toBeNull();
    mocks.findUnique.mockClear();
    expect(await getHostedReturnStatus("short", { now })).toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("serves a 404 for an unknown or expired id and exactly two fields for a known one", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const missing = await get(new Request(`https://events.imsda.test/api/public/square-return/${returnId}`), { params: Promise.resolve({ returnId }) });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toContain("no-store");

    mocks.findUnique.mockResolvedValue(row({ returnExpiresAt: new Date(Date.now() + 60_000) }));
    const found = await get(new Request(`https://events.imsda.test/api/public/square-return/${returnId}`), { params: Promise.resolve({ returnId }) });
    expect(found.status).toBe(200);
    expect(found.headers.get("referrer-policy")).toBe("no-referrer");
    expect(Object.keys(await found.json()).sort()).toEqual(["maskedConfirmationCode", "state"]);
  });

  it("masks a confirmation code and words each state without any registration detail", () => {
    expect(maskConfirmationCode("WR26-4417")).toBe("••••4417");
    expect(maskConfirmationCode("AB1")).toBe("••••");
    for (const state of ["CONFIRMING", "CONFIRMED", "HELD"] as const) {
      expect(hostedReturnMessage(state)).not.toMatch(/\$|WR26|@/);
    }
    expect(hostedReturnMessage("HELD")).toMatch(/refund/);
  });
});
