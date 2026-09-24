import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Q1 (#412): group check-in must be the same per-attendee path as a single
 * check-in — same idempotency, same audit record, same offline queue — never
 * a separate bulk endpoint. This environment has no DOM (see
 * vitest.config.ts), so the reuse is proven at the source level: the bulk
 * actions call the existing `requestCheckIn`/`onConfirmCheckIn` functions the
 * single check-in row already uses, one attendee at a time.
 */

const root = process.cwd();
const workspaceSource = readFileSync(path.join(root, "components/check-in-workspace.tsx"), "utf8");
const scannerSource = readFileSync(path.join(root, "components/check-in-scanner.tsx"), "utf8");
const pageSource = readFileSync(path.join(root, "app/(workspace)/check-in/page.tsx"), "utf8");

describe("club check-in reuses the single check-in path and offline queue", () => {
  it("checks in a club through the same offline-queue-backed requestCheckIn used for one person", () => {
    const checkInManyBody = workspaceSource.slice(
      workspaceSource.indexOf("async function checkInMany("),
      workspaceSource.indexOf("async function checkInMany(") + 700,
    );
    expect(checkInManyBody).toContain("for (const attendeeId of attendeeIds)");
    expect(checkInManyBody).toContain("await requestCheckIn(attendeeId)");
    // No parallel fan-out and no separate bulk fetch call in this function.
    expect(checkInManyBody).not.toContain("fetch(");
    expect(checkInManyBody).not.toContain("Promise.all");
  });

  it("never introduces a bulk check-in API route; the club panel is driven entirely client-side", () => {
    expect(workspaceSource).not.toMatch(/\/attendees\/bulk|\/check-in\/bulk|\/clubs\/[^"'`]*\/check-in/);
  });

  it("passes the same club billing and background-flag data down to the scanner so scanning opens the same club view", () => {
    expect(workspaceSource).toContain("clubsByConfirmationCode={Object.fromEntries(clubByConfirmationCode)}");
    expect(workspaceSource).toContain("backgroundFlaggedAttendeeIds={backgroundFlaggedAttendeeIds}");
  });

  it("searches by club name as well as attendee name/email/confirmation code", () => {
    expect(workspaceSource).toContain("clubByConfirmationCode.get(arrival.confirmationCode)?.organizationName");
  });

  it("checks in a club scanned by QR or confirmation code through the same onConfirmCheckIn used for one person", () => {
    const bulkBody = scannerSource.slice(
      scannerSource.indexOf("async function confirmCheckInMany("),
      scannerSource.indexOf("async function confirmCheckInMany(") + 900,
    );
    expect(bulkBody).toContain("await onConfirmCheckIn(attendee)");
    expect(bulkBody).not.toContain("fetch(");
  });

  it("renders the club panel for a scanned club instead of the plain per-attendee review list", () => {
    expect(scannerSource).toContain("clubsByConfirmationCode[resolution.confirmationCode] && (");
    expect(scannerSource).toContain("<ClubCheckInPanel");
  });

  it("scopes the club roster to the selected event when building the check-in page", () => {
    expect(pageSource).toContain("listClubCheckInInfo(event.id)");
  });
});
