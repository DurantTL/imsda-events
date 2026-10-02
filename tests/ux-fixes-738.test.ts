import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ attendeeAccount: { findMany: prismaMock.findMany } }) }));
vi.mock("@/modules/access/session-store", () => ({ revokeAllUserSessions: vi.fn() }));
vi.mock("@/modules/attendee-accounts/session-store", () => ({ revokeAllAttendeeSessions: vi.fn() }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/modules/communications/account-email-dispatch", () => ({ sendAccountRecoveryEmail: vi.fn() }));

import { AttendeeAccountsWorkspace } from "@/components/attendee-accounts-workspace";
import { namedIssueMessage } from "@/modules/forms/roster-cards";
import { ariaSortFor, nextAccountSort, parseAccountSort, sortAccounts } from "@/modules/system-admin/account-sort";
import { listAttendeeAccounts, type AttendeeAccountSummary } from "@/modules/system-admin/user-admin";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/** WCAG 2.x contrast ratio between two #rrggbb colors. */
function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [luminance(foreground), luminance(background)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("named multi-attendee errors (#738)", () => {
  const names = ["Sam Lee", "Guest 2", "Pat Doe"];

  it("says whose field a missing-answer message is about", () => {
    expect(namedIssueMessage("T-shirt size is required.", 1, names, "Guest")).toBe("Guest 2 — T-shirt size is required.");
    expect(namedIssueMessage("T-shirt size is required.", 0, names, "Guest")).toBe("Sam Lee — T-shirt size is required.");
  });

  it("keeps registration-level and single-attendee messages plain", () => {
    expect(namedIssueMessage("Contact email is required.", null, names, "Guest")).toBe("Contact email is required.");
    expect(namedIssueMessage("T-shirt size is required.", 0, ["Sam Lee"], "Guest")).toBe("T-shirt size is required.");
  });

  it("adds the roster position when two people share a name", () => {
    expect(namedIssueMessage("Age is required.", 2, ["Sam Lee", "Pat Doe", "Sam Lee"], "Guest")).toBe("Sam Lee (Guest 3) — Age is required.");
  });

  it("wires the summary to the named message and always focuses the linked field", () => {
    const source = read("components/public-registration-form.tsx");
    expect(source).toContain("issueSummaryMessage(issue)");
    expect(source).toMatch(/function followIssueLink[\s\S]*?clickEvent\.preventDefault\(\);[\s\S]*?expandAttendeeCardsFor\(\[issue\]\)[\s\S]*?target\?\.focus\(\)/);
    // Validation itself is untouched: the field message stays "<label> is required."
    expect(read("modules/forms/definition.ts")).toContain("message: `${field.label} is required.`");
  });
});

describe("Delete event button contrast (#738)", () => {
  it("uses a pair that passes 4.5:1 and no longer the 2.29:1 navy on coral", () => {
    const css = read("app/globals.css");
    const rule = css.match(/\.lifecycle-danger-button \{([^}]*)\}/)?.[1] ?? "";
    const background = rule.match(/background:\s*(#[0-9a-f]{6})/i)?.[1];
    const color = rule.match(/(?:^|[;\s])color:\s*(#[0-9a-f]{3,6})/i)?.[1];
    expect(background).toBe("#8f3a30");
    expect(color).toBe("#fff");
    expect(contrast("#ffffff", background!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#003b5c", "#a95549")).toBeLessThan(2.3);
  });
});

describe("account sorting (#738)", () => {
  const account = (id: string, over: Partial<AttendeeAccountSummary> = {}): AttendeeAccountSummary => ({
    id, email: `${id}@example.test`, displayName: id, status: "ACTIVE", disabled: false, createdAt: "2026-01-01T00:00:00.000Z",
    lastSignedInAt: null, authenticatorOn: false, passkeyCount: 0, clubRoles: [], areaCoordinator: false, ...over,
  } as AttendeeAccountSummary);

  it("parses, toggles and labels sort state for aria-sort", () => {
    expect(parseAccountSort("name", "desc")).toEqual({ key: "name", direction: "desc" });
    expect(parseAccountSort("bogus", "asc")).toBeNull();
    expect(nextAccountSort(null, "role")).toEqual({ key: "role", direction: "asc" });
    expect(nextAccountSort({ key: "role", direction: "asc" }, "role")).toEqual({ key: "role", direction: "desc" });
    expect(ariaSortFor({ key: "name", direction: "asc" }, "name")).toBe("ascending");
    expect(ariaSortFor({ key: "name", direction: "desc" }, "name")).toBe("descending");
    expect(ariaSortFor({ key: "name", direction: "desc" }, "role")).toBe("none");
  });

  it("sorts by name, role, two-step and last sign-in with empties last", () => {
    const rows = [
      account("bo", { displayName: "Bo", areaCoordinator: true, authenticatorOn: true, lastSignedInAt: "2026-05-01T00:00:00.000Z" }),
      account("al", { displayName: "al", clubRoles: [{ role: "DIRECTOR", clubName: "Eagle" }], passkeyCount: 2 }),
      account("cy", { displayName: "Cy", lastSignedInAt: "2026-06-01T00:00:00.000Z" }),
    ];
    const ids = (sort: Parameters<typeof sortAccounts>[1]) => sortAccounts(rows, sort).map((row) => row.id);
    expect(ids({ key: "name", direction: "asc" })).toEqual(["al", "bo", "cy"]);
    expect(ids({ key: "name", direction: "desc" })).toEqual(["cy", "bo", "al"]);
    expect(ids({ key: "role", direction: "asc" })).toEqual(["bo", "al", "cy"]);
    expect(ids({ key: "role", direction: "desc" })).toEqual(["al", "bo", "cy"]);
    expect(ids({ key: "twostep", direction: "desc" })).toEqual(["bo", "al", "cy"]);
    expect(ids({ key: "signin", direction: "asc" })).toEqual(["bo", "cy", "al"]);
    expect(ids({ key: "signin", direction: "desc" })).toEqual(["cy", "bo", "al"]);
  });

  it("sorts on the server across every match, not just the first page", async () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({
      id: `a${index}`,
      email: `person${String(index).padStart(3, "0")}@example.test`,
      displayName: `Person ${String(index).padStart(3, "0")}`,
      status: "ACTIVE",
      disabledAt: null,
      createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1000),
      mfaEnrollment: null,
      _count: { passkeys: 0 },
      sessions: [],
      areaCoordinatorGrant: null,
      clubDirectorGrants: [],
    }));
    // The database returns newest first; the last-created row sorts first by name.
    prismaMock.findMany.mockResolvedValue([...rows].reverse());
    const sorted = await listAttendeeAccounts("", { key: "name", direction: "asc" });
    expect(sorted).toHaveLength(50);
    expect(sorted[0].displayName).toBe("Person 000");
    expect(sorted[49].displayName).toBe("Person 049");
    expect(prismaMock.findMany.mock.calls.at(-1)?.[0].take).toBeGreaterThan(120);
    const descending = await listAttendeeAccounts("", { key: "name", direction: "desc" });
    expect(descending[0].displayName).toBe("Person 119");
    const unsorted = await listAttendeeAccounts("");
    expect(prismaMock.findMany.mock.calls.at(-1)?.[0].take).toBe(50);
    expect(unsorted).toHaveLength(120);
  });

  it("renders sortable headers with aria-sort and the direction visible", () => {
    const html = renderToStaticMarkup(createElement(AttendeeAccountsWorkspace, {
      initialAccounts: [account("zed"), account("amy")],
      initialQuery: "",
      initialSort: { key: "name", direction: "desc" },
    }));
    expect(html).toContain('aria-sort="descending"');
    expect(html.match(/aria-sort="none"/g)).toHaveLength(3);
    expect(html).toContain("table-sort-button");
    expect(html).toContain("Sort by");
    expect(html).toContain("Descending");
  });

  it("keeps search and sort together in the URL and the API", () => {
    const workspace = read("components/attendee-accounts-workspace.tsx");
    expect(workspace).toContain("window.history.replaceState");
    expect(workspace).toContain('params.set("sort"');
    expect(read("app/api/admin/accounts/route.ts")).toContain('parseAccountSort(params.get("sort"), params.get("dir"))');
    expect(read("app/(workspace)/admin/accounts/page.tsx")).toContain("parseAccountSort(params.sort, params.dir)");
  });
});

describe("meeting-note editor focus (#738)", () => {
  const source = read("components/club-meeting-notes.tsx");

  it("scrolls to and focuses the editor when it opens, for Add and Edit", () => {
    expect(source).toMatch(/editorHeadingRef\.current\?\.scrollIntoView/);
    expect(source).toMatch(/editorHeadingRef\.current\?\.focus/);
    expect(source).toMatch(/\}, \[editorOpen, editingId\]\)/);
    expect(source).toContain('openerRef.current = { kind: "add" }');
    expect(source).toContain('openerRef.current = { kind: "edit", id: note.id }');
    expect(source).toContain("data-meeting-note-add");
    expect(source).toContain("data-meeting-note-edit={note.id}");
  });

  it("returns focus to the opener on Cancel, even when the Add button had unmounted", () => {
    expect(source).toMatch(/function cancel\(\) \{\s*restoreFocusRef\.current = true;/);
    expect(source).toMatch(/\.querySelector\(selector\) as HTMLElement \| null\)\?\.focus\(\)/);
  });
});

describe("spacing and touch targets (#738)", () => {
  it("drops the negative help-text margin under notices on Orders and Class tracking", () => {
    const css = read("components/club-orders.module.css");
    expect(css).toMatch(/\.helpText:global\(\.field-help\)\s*\{\s*margin:\s*6px 0 0/);
    for (const file of ["components/club-order-workspace.tsx", "components/club-earned-awards-workspace.tsx"]) {
      const source = read(file);
      expect(source).not.toMatch(/<p className="field-help"/);
      expect(source).toContain("styles.helpText");
    }
  });

  it("lays out class-tracking section headings with the icon beside the title", () => {
    expect(read("components/club-orders.module.css")).toMatch(/\.block h3 \{ display: flex; align-items: center;/);
  });

  it("sets 44px touch and 36-40px desktop targets on the small controls", () => {
    const css = read("app/globals.css");
    expect(css).toContain("--target-desktop: 36px");
    expect(css).toContain("--target-desktop-icon: 40px");
    expect(css).toContain("--target-touch: 44px");
    expect(css).toMatch(/@media \(max-width: 768px\), \(pointer: coarse\) \{\s*:root :is\(\.primary-button, \.secondary-button, \.text-button, \.filter-field select/);
  });
});
