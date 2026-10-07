import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHURCH_AGREEMENT,
  MAX_OTHER_BOARD_MEMBERS,
  MIN_FILL_SECONDS,
  PHILOSOPHY_STATEMENT,
  directorBackgroundLabels,
  newClubApplicationInputSchema,
  newClubDecisionSchema,
  newClubInviteInputSchema,
  submittedTooQuickly,
} from "@/modules/club-applications/domain";

/** #817: the application's validation, the wording kept verbatim, and the migration's shape. Synthetic data only. */

function valid(overrides: Record<string, unknown> = {}) {
  return {
    clubName: "  Synthetic   Trailblazers ",
    clubType: "PATHFINDER",
    sponsoringChurchId: "church-1",
    sponsoringChurchOther: "",
    pastorName: "Pat Pastor",
    directorName: "Dana Director",
    directorAddress: "100 Example Road, Sampletown, ZZ 00000",
    directorEmail: "  Dana.Director@Example.TEST ",
    directorHomePhone: "555-0100",
    directorWorkPhone: "",
    philosophyAgreed: true,
    pastorSignature: "Pat Pastor",
    headElderSignature: "Hal Elder",
    clerkSignature: "Cleo Clerk",
    directorSignature: "Dana Director",
    otherBoardMembers: [],
    note: "",
    formOpenedAt: 1_700_000_000_000,
    website: "",
    ...overrides,
  };
}

describe("new club application input", () => {
  it("accepts a complete application and cleans it", () => {
    const parsed = newClubApplicationInputSchema.parse(valid());
    expect(parsed.directorEmail).toBe("dana.director@example.test");
    expect(parsed.clubName).toBe("Synthetic   Trailblazers");
    expect(parsed.sponsoringChurchOther).toBeNull();
    expect(parsed.directorWorkPhone).toBeNull();
    expect(parsed.note).toBeNull();
  });

  it("needs the club, pastor, director, address and the four typed signatures", () => {
    for (const field of ["clubName", "pastorName", "directorName", "directorAddress", "pastorSignature", "headElderSignature", "clerkSignature", "directorSignature"]) {
      expect(newClubApplicationInputSchema.safeParse(valid({ [field]: "  " })).success, field).toBe(false);
    }
  });

  it("is Pathfinder or Adventurer only", () => {
    expect(newClubApplicationInputSchema.safeParse(valid({ clubType: "ADVENTURER" })).success).toBe(true);
    expect(newClubApplicationInputSchema.safeParse(valid({ clubType: "EAGLE" })).success).toBe(false);
    expect(newClubApplicationInputSchema.safeParse(valid({ clubType: "" })).success).toBe(false);
  });

  it("takes a directory church or an Other church, never neither and never both", () => {
    expect(newClubApplicationInputSchema.safeParse(valid({ sponsoringChurchId: null, sponsoringChurchOther: "Synthetic Fellowship" })).success).toBe(true);
    expect(newClubApplicationInputSchema.safeParse(valid({ sponsoringChurchId: null, sponsoringChurchOther: "" })).success).toBe(false);
    expect(newClubApplicationInputSchema.safeParse(valid({ sponsoringChurchOther: "Synthetic Fellowship" })).success).toBe(false);
  });

  it("needs the director's email and at least one phone", () => {
    expect(newClubApplicationInputSchema.safeParse(valid({ directorEmail: "not-an-address" })).success).toBe(false);
    expect(newClubApplicationInputSchema.safeParse(valid({ directorHomePhone: "", directorWorkPhone: "" })).success).toBe(false);
    expect(newClubApplicationInputSchema.safeParse(valid({ directorHomePhone: "", directorWorkPhone: "555-0101" })).success).toBe(true);
  });

  it("only takes the application with the church agreement ticked", () => {
    expect(newClubApplicationInputSchema.safeParse(valid({ philosophyAgreed: false })).success).toBe(false);
    expect(newClubApplicationInputSchema.safeParse(valid({ philosophyAgreed: undefined })).success).toBe(false);
  });

  it("keeps the optional board member list short and its names real", () => {
    expect(newClubApplicationInputSchema.parse(valid({ otherBoardMembers: [" Ben Board ", "Bea Board"] })).otherBoardMembers).toEqual(["Ben Board", "Bea Board"]);
    expect(newClubApplicationInputSchema.safeParse(valid({ otherBoardMembers: [""] })).success).toBe(false);
    expect(newClubApplicationInputSchema.safeParse(valid({ otherBoardMembers: Array.from({ length: MAX_OTHER_BOARD_MEMBERS + 1 }, (_, index) => `Member ${index}`) })).success).toBe(false);
  });

  it("refuses the bot trap being filled and unknown fields, and does not take a date from the sender", () => {
    expect(newClubApplicationInputSchema.safeParse(valid({ website: "https://spam.example" })).success).toBe(false);
    expect(newClubApplicationInputSchema.safeParse(valid({ status: "APPROVED" })).success).toBe(false);
    expect(newClubApplicationInputSchema.safeParse(valid({ applicationDate: "2020-01-01" })).success).toBe(false);
  });

  it("treats a form sent in a few seconds as a bot", () => {
    const opened = Date.parse("2026-10-08T12:00:00Z");
    expect(submittedTooQuickly(opened, new Date(opened + (MIN_FILL_SECONDS - 1) * 1000))).toBe(true);
    expect(submittedTooQuickly(opened, new Date(opened + (MIN_FILL_SECONDS + 1) * 1000))).toBe(false);
  });
});

describe("the wording from the paper form", () => {
  it("shows the philosophy statement and the church agreement exactly as written", () => {
    expect(PHILOSOPHY_STATEMENT.startsWith("The purpose of having a Pathfinder club is to lead its membership into a growing, redemptive relationship with Christ")).toBe(true);
    expect(PHILOSOPHY_STATEMENT).toContain("The Pathfinder club is an extension of the home, school, and church, it is an experimental laboratory where growth and learning flourish.");
    expect(PHILOSOPHY_STATEMENT).toContain("youth in grades 5-10 who have a desire for group activities");
    expect(PHILOSOPHY_STATEMENT.endsWith("to actively expand their personal experience with Christ.")).toBe(true);
    expect(CHURCH_AGREEMENT.startsWith("We, the undersigned, have read, understand, and are in full agreement with the above philosophy of Pathfindering")).toBe(true);
    expect(CHURCH_AGREEMENT.endsWith("and to assist and support the work of the Pathfinder ministry in the conference, and around the world.")).toBe(true);
  });

  it("uses the existing Sterling Volunteers status labels", () => {
    expect(directorBackgroundLabels).toEqual({ CLEAR: "Clear", FLAGGED: "Expiring soon", NOT_COMPLIANT: "Not in compliance", NO_RECORD: "No record" });
  });
});

describe("invites and decisions", () => {
  it("lowercases the invited email", () => {
    expect(newClubInviteInputSchema.parse({ email: " New.Director@Example.TEST " }).email).toBe("new.director@example.test");
    expect(newClubInviteInputSchema.safeParse({ email: "nope" }).success).toBe(false);
  });

  it("approves, or declines with an optional reason", () => {
    expect(newClubDecisionSchema.parse({ decision: "approve" })).toEqual({ decision: "approve" });
    expect(newClubDecisionSchema.parse({ decision: "decline" })).toEqual({ decision: "decline" });
    expect(newClubDecisionSchema.parse({ decision: "decline", declineReason: " Not this year " })).toEqual({ decision: "decline", declineReason: "Not this year" });
    expect(newClubDecisionSchema.safeParse({ decision: "decline", declineReason: "x".repeat(501) }).success).toBe(false);
    expect(newClubDecisionSchema.safeParse({ decision: "maybe" }).success).toBe(false);
  });
});

describe("the migration", () => {
  const migration = readFileSync(new URL("../prisma/migrations/20261008200000_new_club_applications/migration.sql", import.meta.url), "utf8");
  const sql = migration.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

  it("creates the application and invite tables with the attachment, decision and created-club columns", () => {
    expect(sql).toContain('CREATE TABLE "NewClubApplication"');
    expect(sql).toContain('CREATE TABLE "NewClubApplicationInvite"');
    for (const column of ["status", "clubName", "clubType", "sponsoringChurchId", "sponsoringChurchOther", "pastorName", "directorName", "directorAddress", "directorEmail", "directorHomePhone", "directorWorkPhone", "philosophyAgreed", "pastorSignature", "headElderSignature", "clerkSignature", "directorSignature", "otherBoardMembers", "applicationDate", "attachmentStorageKey", "source", "decidedByUserId", "decidedAt", "declineReason", "createdOrganizationId", "createdAt", "updatedAt"]) {
      expect(sql, column).toContain(`"${column}"`);
    }
    expect(sql).toContain('CREATE UNIQUE INDEX "NewClubApplication_createdOrganizationId_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "NewClubApplicationInvite_tokenHash_key"');
  });

  it("is additive: one nullable settings column and enum values, no drops, deletes or updates", () => {
    expect(sql).toContain('ALTER TABLE "PlatformSettings" ADD COLUMN     "newClubApplicationEmail" TEXT;');
    for (const value of ["NEW_CLUB_APPLICATION_SUBMITTED", "NEW_CLUB_APPLICATION_DECLINED", "NEW_CLUB_APPLICATION_INVITE"]) {
      expect(sql).toContain(`ADD VALUE '${value}'`);
    }
    for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
      expect(statement).not.toMatch(/^(DELETE|UPDATE|TRUNCATE|DROP)\b/i);
      expect(statement).not.toMatch(/^ALTER TABLE "(?!NewClubApplication|PlatformSettings")/);
    }
  });
});
