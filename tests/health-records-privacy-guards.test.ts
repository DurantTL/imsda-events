import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const root = process.cwd();

function sourceFiles(directory: string): string[] {
  return readdirSync(join(root, directory)).flatMap((name) => {
    const path = join(directory, name);
    return statSync(join(root, path)).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("health data stays out of exports, the check-in book, communications and logs", () => {
  const importsHealth = /from "@\/modules\/health-records\//;

  it("is imported only by its own module, its routes and pages, the roster page tab and the email worker", () => {
    const allowedOutside = new Set([
      "app/(public)/account/(portal)/clubs/[organizationId]/roster/page.tsx",
      "modules/communications/email-delivery.ts",
    ]);
    const offenders = [...sourceFiles("modules"), ...sourceFiles("components"), ...sourceFiles("app"), ...sourceFiles("lib")]
      .filter((path) => !path.startsWith("modules/health-records/"))
      .filter((path) => importsHealth.test(read(path)))
      .filter((path) => !allowedOutside.has(path))
      .filter((path) => !/health/i.test(path));
    expect(offenders).toEqual([]);
  });

  it("is never read by CSV, export, check-in, reporting, club report or message-composing code", () => {
    const guarded = [
      ...sourceFiles("modules/checkin"),
      ...sourceFiles("modules/reporting"),
      ...sourceFiles("modules/club-reports"),
      ...sourceFiles("modules/club-rosters").filter((path) => /export|csv/.test(path)),
      ...sourceFiles("modules/club-forms").filter((path) => /csv|submissions/.test(path)),
      ...sourceFiles("modules/communications").filter((path) => path !== "modules/communications/email-delivery.ts"),
      ...sourceFiles("modules/imports"),
    ];
    expect(guarded.length).toBeGreaterThan(10);
    for (const path of guarded) {
      expect(read(path), relative(root, path)).not.toMatch(/health-records|healthRecord|HealthRecord/);
    }
  });

  it("lets the email worker use only the link email helpers, which carry no health text", () => {
    const delivery = read("modules/communications/email-delivery.ts");
    const imports = [...delivery.matchAll(/from "@\/modules\/health-records\/([a-z-]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual(["link-email"]);
  });

  it("never writes to the console and logs only through the redacting logger", () => {
    for (const path of sourceFiles("modules/health-records")) {
      const source = read(path);
      expect(source, path).not.toMatch(/console\.(log|info|warn|error|debug)/);
      for (const call of source.matchAll(/logError\(([^)]*)\)/g)) {
        // The action text and the error object: never a record, a field value or a request body.
        expect(call[1], path).toMatch(/^(action|`\$\{action\} failed`), error$/);
      }
    }
  });

  it("builds the link email from the club name and expiry only", async () => {
    const { healthRecordLinkEmailContent } = await import("@/modules/health-records/link-email");
    const content = healthRecordLinkEmailContent({ clubName: "Synthetic Pathfinders", days: 14, expiresOn: "October 19, 2026" });
    expect(content.bodyText).toContain("{{health_record_link}}");
    expect(content.bodyText).not.toMatch(/allerg|medicat|insurance|diagnos|birth/i);
  });
});

describe("removing a roster member erases their Health Record", () => {
  it("deletes the record and withdraws open links in the same transaction, flag on or off", async () => {
    const calls: string[] = [];
    const tx = {
      clubMeetingAttendance: { deleteMany: vi.fn(async () => { calls.push("attendance"); }) },
      healthRecord: { deleteMany: vi.fn(async () => { calls.push("healthRecord"); }) },
      healthRecordLink: { updateMany: vi.fn(async () => { calls.push("healthRecordLink"); }) },
      clubRosterMember: { update: vi.fn(async () => { calls.push("member"); }) },
    };
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => ({}) }));
    const { eraseRosterRow } = await import("@/modules/club-rosters/repository");
    await eraseRosterRow(tx as never, "member-1", new Date("2026-10-05T15:00:00Z"));
    expect(tx.healthRecord.deleteMany).toHaveBeenCalledWith({ where: { rosterMemberId: "member-1" } });
    expect(tx.healthRecordLink.updateMany).toHaveBeenCalledWith({
      where: { rosterMemberId: "member-1", status: "OPEN" },
      data: expect.objectContaining({ status: "REVOKED", tokenHash: null }),
    });
    expect(calls.indexOf("healthRecord")).toBeLessThan(calls.indexOf("member"));
  });
});

describe("the Area Coordinator reaches health records only through the event-scoped view", () => {
  it("has exactly one coordinator page and one coordinator route that use the health module", () => {
    const area = [
      ...sourceFiles("modules/organizations").filter((path) => /area/.test(path)),
      ...sourceFiles("modules/club-reports"),
      ...sourceFiles("app/(public)/account/(portal)/area-clubs"),
      ...sourceFiles("app/api/attendee/area-clubs"),
    ];
    const users = area.filter((path) => /health-records/.test(read(path))).sort();
    expect(users).toEqual([
      "app/(public)/account/(portal)/area-clubs/health/[eventId]/[organizationId]/[memberId]/page.tsx",
      "app/api/attendee/area-clubs/health/[eventId]/[organizationId]/[memberId]/route.ts",
    ]);
  });

  it("never lets the coordinator summary, export or roster code touch health data", () => {
    for (const path of sourceFiles("modules/club-reports")) expect(read(path), path).not.toMatch(/healthRecord|HealthRecord/);
  });
});
