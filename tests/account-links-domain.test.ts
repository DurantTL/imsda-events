import { describe, expect, it } from "vitest";
import {
  attendeeAccountPersonLinkInputSchema,
  userPersonLinkInputSchema,
} from "@/modules/people/account-links-domain";

describe("attendeeAccountPersonLinkInputSchema", () => {
  it("accepts a self-service link actored by the account", () => {
    const parsed = attendeeAccountPersonLinkInputSchema.parse({
      personId: "per_alicia",
      provenance: "SELF_SERVICE_VERIFICATION",
      actorAttendeeAccountId: "acc_alicia",
      evidenceReference: "verification-token:tok_123",
    });
    expect(parsed.provenance).toBe("SELF_SERVICE_VERIFICATION");
  });

  it("rejects a self-service link with no actor account", () => {
    expect(() =>
      attendeeAccountPersonLinkInputSchema.parse({
        personId: "per_alicia",
        provenance: "SELF_SERVICE_VERIFICATION",
        evidenceReference: "verification-token:tok_123",
      }),
    ).toThrow();
  });

  it("rejects a self-service link that also names a staff actor", () => {
    expect(() =>
      attendeeAccountPersonLinkInputSchema.parse({
        personId: "per_alicia",
        provenance: "SELF_SERVICE_VERIFICATION",
        actorAttendeeAccountId: "acc_alicia",
        actorUserId: "usr_dana",
        evidenceReference: "verification-token:tok_123",
      }),
    ).toThrow();
  });

  it.each(["STAFF_ACTION", "IMPORT"] as const)("accepts a %s link actored by a staff user", (provenance) => {
    const parsed = attendeeAccountPersonLinkInputSchema.parse({
      personId: "per_alicia",
      provenance,
      actorUserId: "usr_dana",
      evidenceReference: "staff-note:note_1",
    });
    expect(parsed.provenance).toBe(provenance);
  });

  it.each(["STAFF_ACTION", "IMPORT"] as const)("rejects a %s link with no staff actor", (provenance) => {
    expect(() =>
      attendeeAccountPersonLinkInputSchema.parse({
        personId: "per_alicia",
        provenance,
        evidenceReference: "staff-note:note_1",
      }),
    ).toThrow();
  });

  it("rejects an empty evidence reference", () => {
    expect(() =>
      attendeeAccountPersonLinkInputSchema.parse({
        personId: "per_alicia",
        provenance: "STAFF_ACTION",
        actorUserId: "usr_dana",
        evidenceReference: "   ",
      }),
    ).toThrow();
  });
});

describe("userPersonLinkInputSchema", () => {
  it("always requires a staff actor, whatever the provenance", () => {
    expect(() =>
      userPersonLinkInputSchema.parse({
        personId: "per_dana",
        provenance: "SELF_SERVICE_VERIFICATION",
        evidenceReference: "verification-token:tok_9",
      }),
    ).toThrow();

    const parsed = userPersonLinkInputSchema.parse({
      personId: "per_dana",
      provenance: "SELF_SERVICE_VERIFICATION",
      actorUserId: "usr_dana",
      evidenceReference: "verification-token:tok_9",
    });
    expect(parsed.actorUserId).toBe("usr_dana");
  });
});
