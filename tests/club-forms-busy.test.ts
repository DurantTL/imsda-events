import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { clubFormApiError } from "@/modules/club-forms/api-errors";
import { ClubFormError, formBusyError, isLockTimeoutError } from "@/modules/club-forms/errors";

describe("a wait for a template lock that gave up (#610)", () => {
  it.each([
    [{ code: "P2010", meta: { code: "55P03" }, message: "Raw query failed." }],
    [{ code: "P2028", message: "Transaction API error" }],
    [{ code: "55P03" }],
    [new Error("canceling statement due to lock timeout")],
  ])("is recognised: %j", (error) => {
    expect(isLockTimeoutError(error)).toBe(true);
  });

  it.each([[new Error("connection lost")], [{ code: "P2002" }], [null], ["55P03"]])("does not mistake %j for one", (error) => {
    expect(isLockTimeoutError(error)).toBe(false);
  });

  it("maps FORM_BUSY to a 503 with the try-again message and a Retry-After", async () => {
    const response = clubFormApiError(formBusyError(), "Saving a club form");
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toEqual({ error: "FORM_BUSY", message: "This form is being updated. Please try again in a minute." });
  });

  it("maps a raw lock timeout that escaped a route to the same 503", async () => {
    const response = clubFormApiError({ code: "P2028", message: "Transaction API error" }, "Saving a club form");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "FORM_BUSY" });
  });

  it("maps a template that needs a sync to a 409 that names the fix", async () => {
    const response = clubFormApiError(new ClubFormError("TEMPLATE_NEEDS_SYNC", "Run npm run club-forms:sync."), "Changing a club form");
    expect(response.status).toBe(409);
  });
});
