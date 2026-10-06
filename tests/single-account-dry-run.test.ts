import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildReport,
  detectConflicts,
  formatReportText,
  maskEmail,
  pairKey,
  pairAccounts,
  pairStatus,
  type AttendeeAccountRow,
  type StaffAccountRow,
} from "@/modules/account-merge/dry-run-domain";
import { runSingleAccountDryRun, withReadOnlyTransaction } from "@/modules/account-merge/dry-run";

const NOW = new Date("2026-10-06T12:00:00Z");
const VERIFIED = new Date("2026-01-01T00:00:00Z");

function staff(over: Partial<StaffAccountRow> & { id: string; email: string }): StaffAccountRow {
  return {
    accountStatus: "ACTIVE",
    globalRole: null,
    credential: { disabledAt: null, lockedUntil: null },
    mfa: "ACTIVE",
    mfaLockedUntil: null,
    personLinkPersonId: null,
    counts: { memberships: 1, activeMemberships: 1, passkeys: 0, sessions: 0, auditRows: 3, actorRows: 5 },
    ...over,
  };
}

function attendee(over: Partial<AttendeeAccountRow> & { id: string; email: string }): AttendeeAccountRow {
  return {
    status: "ACTIVE",
    emailVerifiedAt: VERIFIED,
    disabledAt: null,
    credential: null,
    hasGoogleIdentity: false,
    mfa: "NONE",
    mfaLockedUntil: null,
    personLinkPersonId: null,
    counts: { registrations: 2, clubRoles: 0, areaCoordinator: 0, passkeys: 0, sessions: 0, actorRows: 0 },
    ...over,
  };
}

const codes = (s: StaffAccountRow, a: AttendeeAccountRow, nameDiffers?: Set<string>) =>
  detectConflicts({ staff: s, attendee: a }, NOW, nameDiffers).map((conflict) => conflict.code);

describe("maskEmail", () => {
  it("keeps one character of the local part, one of the domain and the top-level domain", () => {
    expect(maskEmail("Jordan.Example@Example.test")).toBe("j***@e***.test");
    expect(maskEmail("a.b@mail.church.example.org")).toBe("a***@m***.org");
    expect(maskEmail("x@localhost")).toBe("x***@l***");
  });
  it("keeps the domain of a short list of common providers", () => {
    for (const domain of ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com"]) {
      expect(maskEmail(`Jordan@${domain.toUpperCase()}`)).toBe(`j***@${domain}`);
    }
    expect(maskEmail("jordan@gmail.com.example.org")).toBe("j***@g***.org");
  });
  it("never reveals a malformed value", () => {
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskEmail("@example.test")).toBe("***");
    expect(maskEmail("a@")).toBe("***");
  });
});

describe("pairAccounts", () => {
  it("pairs by normalised email and counts the unpaired sides", () => {
    const result = pairAccounts(
      [
        staff({ id: "u1", email: "Pat@Example.test " }),
        staff({ id: "u2", email: "staffonly@example.test" }),
      ],
      [
        attendee({ id: "a1", email: "pat@example.test" }),
        attendee({ id: "a2", email: "guest@example.test" }),
        attendee({ id: "a3", email: "guest2@example.test" }),
      ],
    );
    expect(result.pairs.map((pair) => [pair.staff.id, pair.attendee.id])).toEqual([["u1", "a1"]]);
    expect(result.staffOnly.map((row) => row.id)).toEqual(["u2"]);
    expect(result.attendeeOnly.map((row) => row.id).sort()).toEqual(["a2", "a3"]);
    expect(result.ambiguous).toEqual([]);
  });

  it("keeps different-email people separate (no fuzzy matching on name)", () => {
    const result = pairAccounts(
      [staff({ id: "u1", email: "pat.work@example.test" })],
      [attendee({ id: "a1", email: "pat.home@example.test" })],
    );
    expect(result.pairs).toEqual([]);
    expect(result.staffOnly).toHaveLength(1);
    expect(result.attendeeOnly).toHaveLength(1);
  });

  it("never pairs a group with duplicates on either side", () => {
    const result = pairAccounts(
      [staff({ id: "u1", email: "dup@example.test" }), staff({ id: "u2", email: "DUP@example.test" })],
      [attendee({ id: "a1", email: "dup@example.test" })],
    );
    expect(result.pairs).toEqual([]);
    expect(result.ambiguous).toEqual([{ emailKey: "dup@example.test", staffIds: ["u1", "u2"], attendeeIds: ["a1"] }]);
    expect(result.staffOnly).toEqual([]);
    expect(result.attendeeOnly).toEqual([]);
  });

  it("reports same-side duplicates as ambiguous even with no counterpart", () => {
    const result = pairAccounts(
      [staff({ id: "u1", email: "solo@example.test" }), staff({ id: "u2", email: "SOLO@example.test" })],
      [attendee({ id: "a1", email: "twin@example.test" }), attendee({ id: "a2", email: "Twin@example.test" })],
    );
    expect(result.pairs).toEqual([]);
    expect(result.staffOnly).toEqual([]);
    expect(result.attendeeOnly).toEqual([]);
    expect(result.ambiguous).toEqual([
      { emailKey: "solo@example.test", staffIds: ["u1", "u2"], attendeeIds: [] },
      { emailKey: "twin@example.test", staffIds: [], attendeeIds: ["a1", "a2"] },
    ]);
  });
});

describe("detectConflicts", () => {
  const s = staff({ id: "u1", email: "pat@example.test" });
  const a = attendee({ id: "a1", email: "pat@example.test" });

  it("reports a clean pair with nothing to decide", () => {
    expect(codes(s, a)).toEqual([]);
    expect(pairStatus(detectConflicts({ staff: s, attendee: a }, NOW))).toBe("clean");
  });

  it("flags two passwords (different by assumption) as review", () => {
    const both = attendee({ ...a, credential: { disabledAt: null, lockedUntil: null } });
    expect(codes(s, both)).toContain("BOTH_HAVE_PASSWORD");
    expect(pairStatus(detectConflicts({ staff: s, attendee: both }, NOW))).toBe("needs-review");
    // An attendee password alone, or a disabled one, is not a password conflict.
    expect(codes(staff({ ...s, credential: null }), both)).not.toContain("BOTH_HAVE_PASSWORD");
    const disabled = attendee({ ...a, credential: { disabledAt: VERIFIED, lockedUntil: null } });
    expect(codes(s, disabled)).not.toContain("BOTH_HAVE_PASSWORD");
  });

  it("flags different MFA: two secrets, or attendee-only", () => {
    expect(codes(s, attendee({ ...a, mfa: "ACTIVE" }))).toContain("MFA_BOTH_ENROLLED");
    expect(codes(staff({ ...s, mfa: "NONE" }), attendee({ ...a, mfa: "ACTIVE" }))).toContain("MFA_ATTENDEE_ONLY");
    // A pending enrolment is not a confirmed factor.
    expect(codes(s, attendee({ ...a, mfa: "PENDING" }))).toEqual([]);
  });

  it("flags names the database reports as different, for that pair only", () => {
    expect(codes(s, a, new Set([pairKey("u1", "a1")]))).toContain("NAME_MISMATCH");
    expect(codes(s, a, new Set([pairKey("u1", "other")]))).not.toContain("NAME_MISMATCH");
    expect(codes(s, a)).not.toContain("NAME_MISMATCH");
  });

  it("flags an authenticator lockout that is still in force", () => {
    const future = new Date(NOW.getTime() + 60_000);
    const past = new Date(NOW.getTime() - 60_000);
    expect(codes(staff({ ...s, mfaLockedUntil: future }), a)).toContain("MFA_LOCKED");
    expect(codes(s, attendee({ ...a, mfaLockedUntil: future }))).toContain("MFA_LOCKED");
    expect(codes(staff({ ...s, mfaLockedUntil: past }), a)).not.toContain("MFA_LOCKED");
  });

  it("blocks a staff role with no confirmed authenticator and no passkey", () => {
    const bare = staff({ ...s, mfa: "NONE" });
    const found = detectConflicts({ staff: bare, attendee: a }, NOW);
    expect(found.map((c) => c.code)).toContain("STAFF_NO_SECOND_FACTOR");
    expect(pairStatus(found)).toBe("blocked");
    // A pending enrolment is not a factor; a passkey, or no role at all, is fine.
    expect(codes(staff({ ...s, mfa: "PENDING" }), a)).toContain("STAFF_NO_SECOND_FACTOR");
    expect(codes(staff({ ...bare, counts: { ...bare.counts, passkeys: 1 } }), a)).not.toContain("STAFF_NO_SECOND_FACTOR");
    expect(codes(staff({ ...bare, counts: { ...bare.counts, activeMemberships: 0 } }), a)).not.toContain("STAFF_NO_SECOND_FACTOR");
    expect(codes(staff({ ...bare, globalRole: "SYSTEM_ADMIN", counts: { ...bare.counts, activeMemberships: 0 } }), a)).toContain("STAFF_NO_SECOND_FACTOR");
  });

  it("blocks a disabled attendee account", () => {
    const found = detectConflicts({ staff: s, attendee: attendee({ ...a, disabledAt: VERIFIED }) }, NOW);
    expect(found.map((c) => c.code)).toContain("ATTENDEE_DISABLED");
    expect(pairStatus(found)).toBe("blocked");
  });

  it("blocks a disabled staff credential and a never-activated staff account", () => {
    expect(codes(staff({ ...s, credential: { disabledAt: VERIFIED, lockedUntil: null } }), a)).toContain("STAFF_CREDENTIAL_DISABLED");
    expect(codes(staff({ ...s, accountStatus: "PENDING_ACTIVATION" }), a)).toContain("STAFF_NOT_ACTIVATED");
  });

  it("blocks an unverified attendee email, however it got there", () => {
    expect(codes(s, attendee({ ...a, status: "PENDING_VERIFICATION", emailVerifiedAt: null }))).toContain("ATTENDEE_EMAIL_UNVERIFIED");
    // Belt and braces, as the sign-in code does: ACTIVE without a date is unverified.
    expect(codes(s, attendee({ ...a, emailVerifiedAt: null }))).toContain("ATTENDEE_EMAIL_UNVERIFIED");
  });

  it("blocks accounts linked to different Person records, not the same one", () => {
    expect(codes(staff({ ...s, personLinkPersonId: "p1" }), attendee({ ...a, personLinkPersonId: "p2" }))).toContain("PERSON_LINK_MISMATCH");
    expect(codes(staff({ ...s, personLinkPersonId: "p1" }), attendee({ ...a, personLinkPersonId: "p1" }))).toEqual([]);
    expect(codes(staff({ ...s, personLinkPersonId: "p1" }), a)).toEqual([]);
  });

  it("only counts a lockout that is still in force", () => {
    const future = new Date(NOW.getTime() + 60_000);
    const past = new Date(NOW.getTime() - 60_000);
    expect(codes(staff({ ...s, credential: { disabledAt: null, lockedUntil: future } }), a)).toContain("CREDENTIAL_LOCKED");
    expect(codes(staff({ ...s, credential: { disabledAt: null, lockedUntil: past } }), a)).not.toContain("CREDENTIAL_LOCKED");
  });

  it("notes passkeys on both sides and a Google identity as information only", () => {
    const both = detectConflicts({
      staff: staff({ ...s, counts: { ...s.counts, passkeys: 1 } }),
      attendee: attendee({ ...a, hasGoogleIdentity: true, counts: { ...a.counts, passkeys: 2 } }),
    }, NOW);
    expect(both.map((c) => c.code).sort()).toEqual(["ATTENDEE_GOOGLE_IDENTITY", "PASSKEYS_ON_BOTH"]);
    expect(pairStatus(both)).toBe("clean");
  });
});

describe("buildReport", () => {
  const staffRows = [
    staff({ id: "u1", email: "pat@example.test", globalRole: "SYSTEM_ADMIN" }),
    staff({ id: "u2", email: "staffonly@example.test" }),
  ];
  const attendeeRows = [
    attendee({ id: "a1", email: "pat@example.test" }),
    attendee({ id: "a2", email: "guest@example.test" }),
  ];

  it("masks emails and omits names by default", () => {
    const report = buildReport(staffRows, attendeeRows, { showEmails: false, now: NOW, nameDiffers: new Set([pairKey("u1", "a1")]) });
    const serialized = JSON.stringify(report);
    expect(report.pairs[0].email).toBe("p***@e***.test");
    expect(serialized).not.toContain("pat@example.test");
    expect(serialized).not.toContain("example.test");
    expect(formatReportText(report)).not.toContain("pat@example.test");
    expect(report.summary).toMatchObject({
      staffAccounts: 2,
      attendeeAccounts: 2,
      pairs: 1,
      staffOnly: 1,
      attendeeOnly: 1,
      ambiguousGroups: 0,
      pairsByStatus: { clean: 0, "needs-review": 1, blocked: 0 },
      conflictCounts: { NAME_MISMATCH: 1 },
    });
    expect(report.pairs[0]).toMatchObject({
      staffUserId: "u1",
      attendeeAccountId: "a1",
      staff: { globalRole: "SYSTEM_ADMIN", auditRows: 3, actorRows: 5 },
      attendee: { registrations: 2 },
    });
    expect(report.readOnly).toBe(true);
  });

  it("masks the emails of ambiguous groups too", () => {
    const report = buildReport(
      [staff({ id: "u1", email: "dup@example.test" }), staff({ id: "u2", email: "DUP@example.test" })],
      [attendee({ id: "a1", email: "dup@example.test" })],
      { showEmails: false, now: NOW },
    );
    expect(report.ambiguous).toEqual([{ email: "d***@e***.test", staffIds: ["u1", "u2"], attendeeIds: ["a1"] }]);
    expect(JSON.stringify(report)).not.toContain("dup@example.test");
    expect(formatReportText(report)).not.toContain("dup@example.test");
  });

  it("shows full emails only when asked", () => {
    const report = buildReport(staffRows, attendeeRows, { showEmails: true, now: NOW });
    expect(report.emailsShown).toBe(true);
    expect(report.pairs[0].email).toBe("pat@example.test");
  });
});

/** A fake client that records statements and refuses every write. */
function fakeClient() {
  const log: string[] = [];
  const writeError = () => {
    throw new Error("write attempted in dry run");
  };
  const modelProxy = (name: string) =>
    new Proxy({}, {
      get: (_target, method: string) => {
        if (/^(create|update|delete|upsert)/.test(method)) return writeError;
        return async () => {
          log.push(`${name}.${method}`);
          return [];
        };
      },
    });
  const tx = new Proxy({}, {
    get: (_target, prop: string) => {
      if (prop === "$executeRaw") {
        return async (strings: TemplateStringsArray) => {
          log.push(`$executeRaw ${strings.join("?").trim()}`);
          return 0;
        };
      }
      if (prop === "$executeRawUnsafe" || prop === "$queryRawUnsafe") return writeError;
      if (prop === "$queryRaw") {
        return async () => {
          log.push("$queryRaw");
          return [];
        };
      }
      return modelProxy(prop);
    },
  });
  const options_: unknown[] = [];
  const prisma = {
    $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>, opts?: unknown) => {
      options_.push(opts);
      return callback(tx);
    }),
  };
  return { prisma, log, options_, tx };
}

describe("read-only guarantee", () => {
  it("starts the transaction with SET TRANSACTION READ ONLY, before any query", async () => {
    const { prisma, log, options_ } = fakeClient();
    await runSingleAccountDryRun(prisma as never, { showEmails: false, now: NOW });
    expect(log[0]).toBe("$executeRaw SET TRANSACTION READ ONLY");
    expect(log.length).toBeGreaterThan(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(options_[0]).toMatchObject({ isolationLevel: "RepeatableRead" });
  });

  it("cannot be used to write through the helper's transaction client", async () => {
    const { prisma, tx } = fakeClient();
    await expect(
      withReadOnlyTransaction(prisma as never, async () => (tx as { user: { create: () => void } }).user.create()),
    ).rejects.toThrow("write attempted");
  });

  it("contains no write calls in its source", () => {
    for (const file of ["modules/account-merge/dry-run.ts", "scripts/single-account-dry-run.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\.(create|update|upsert|delete)(Many)?\s*\(/);
      expect(source, file).not.toMatch(/\$(execute|query)RawUnsafe|INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM/i);
    }
  });
});
