import { beforeEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/logger")>()), logError: logged.logError }));

import { clubFormApiError } from "@/modules/club-forms/api-errors";
import { ClubFormError, formBusyError, formUnavailableError, isLockTimeoutError } from "@/modules/club-forms/errors";

beforeEach(() => vi.clearAllMocks());

describe("a wait for a template lock that gave up (#610)", () => {
  it.each([
    [{ code: "P2010", meta: { code: "55P03" }, message: "Raw query failed." }],
    [{ code: "55P03" }],
    [new Error("canceling statement due to lock timeout")],
  ])("is recognised: %j", (error) => {
    expect(isLockTimeoutError(error)).toBe(true);
  });

  it.each([
    [new Error("connection lost")],
    [{ code: "P2002" }],
    [{ code: "P2028", message: "Transaction API error" }],
    [null],
    ["55P03"],
  ])("does not mistake %j for one", (error) => {
    expect(isLockTimeoutError(error)).toBe(false);
  });

  it("maps FORM_BUSY to a 503 with the try-again message and a Retry-After, and logs it", async () => {
    const response = clubFormApiError(formBusyError(), "Saving a club form");
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toEqual({ error: "FORM_BUSY", message: "This form is being updated. Please try again in a minute." });
    expect(logged.logError).toHaveBeenCalledWith("Saving a club form", expect.any(ClubFormError));
  });

  it("maps a raw Postgres lock timeout that escaped a route to the same 503, and logs the error", async () => {
    const failure = { code: "P2010", meta: { code: "55P03" }, message: "Raw query failed." };
    const response = clubFormApiError(failure, "Saving a club form");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "FORM_BUSY" });
    expect(logged.logError).toHaveBeenCalledWith("Saving a club form", failure);
  });

  it("does not read a Prisma transaction error at the API boundary as 'being updated'", async () => {
    const response = clubFormApiError({ code: "P2028", message: "Transaction API error" }, "Saving a club form");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "CLUB_FORM_REQUEST_FAILED" });
  });

  it("gives a template that is behind the code its own 503 message", async () => {
    const response = clubFormApiError(formUnavailableError(), "Opening a club form link");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "FORM_UNAVAILABLE", message: "This form is temporarily unavailable. Please try again later." });
    expect(logged.logError).toHaveBeenCalled();
  });

  it("maps a template that needs a sync to a 409 that names the fix", async () => {
    const response = clubFormApiError(new ClubFormError("TEMPLATE_NEEDS_SYNC", "Run npm run club-forms:sync."), "Changing a club form");
    expect(response.status).toBe(409);
  });
});
