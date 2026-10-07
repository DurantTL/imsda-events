/* eslint-disable @typescript-eslint/no-explicit-any -- the fake database receives loosely typed Prisma arguments */
import { describe, expect, it, vi } from "vitest";

/**
 * #817: the Sterling Volunteers flag on a new club application. A director is
 * matched to a person by email; when the email reaches several people the least
 * favorable status is shown and the result is marked ambiguous; when the matched
 * person's name isn't the typed director's name it is marked as a mismatch.
 * Synthetic people only.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: vi.fn() }));

import { directorMatchKey } from "@/modules/background-checks/director-match";
import { directorBackgroundStatesByEmail } from "@/modules/background-checks/repository";

const NOW = new Date("2026-10-08T15:00:00Z");
const EMAIL = "dana.director@example.test";
const KEY = directorMatchKey(EMAIL, "Dana Director");

function person(id: string, firstName: string, lastName: string, expiresOn: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    firstName,
    lastName,
    normalizedEmail: EMAIL,
    attendeeAccountLinks: [],
    backgroundCheckMatch: expiresOn ? { entry: { complianceStatus: null, expiresOn } } : null,
    ...extra,
  };
}

function database(people: any[]) {
  return {
    person: { findMany: vi.fn(async () => people) },
    // No list entries to match at read time.
    backgroundCheckEntry: { findMany: vi.fn(async () => []) },
  } as any;
}

const typed = (name = "Dana Director", email = EMAIL) => [{ email, name }];

describe("directorBackgroundStatesByEmail", () => {
  it("is No record for a director nobody matches", async () => {
    const result = await directorBackgroundStatesByEmail(typed(), NOW, database([]));
    expect(result.get(KEY)).toEqual({ state: "NO_RECORD", ambiguous: false, nameMismatch: false });
  });

  it("is Clear for one person with a current check and the same name", async () => {
    const result = await directorBackgroundStatesByEmail(typed(), NOW, database([person("p1", "Dana", "Director", "2030-01-02")]));
    expect(result.get(KEY)).toEqual({ state: "CLEAR", ambiguous: false, nameMismatch: false });
  });

  it("shows the least favorable status, and says so, when the email reaches two people", async () => {
    const result = await directorBackgroundStatesByEmail(typed(), NOW, database([
      person("p1", "Dana", "Director", "2030-01-02"),
      person("p2", "Dana", "Director", null),
    ]));
    expect(result.get(KEY)).toEqual({ state: "NO_RECORD", ambiguous: true, nameMismatch: false });
  });

  it("treats an expired check as worse than no record", async () => {
    const result = await directorBackgroundStatesByEmail(typed(), NOW, database([
      person("p1", "Dana", "Director", null),
      person("p2", "Dana", "Director", "2020-01-02"),
    ]));
    expect(result.get(KEY)).toMatchObject({ state: "NOT_COMPLIANT", ambiguous: true });
  });

  it("marks a name mismatch: found by email, but a different person", async () => {
    const result = await directorBackgroundStatesByEmail(typed("Dana Director"), NOW, database([person("p1", "Robert", "Stranger", "2030-01-02")]));
    expect(result.get(KEY)).toEqual({ state: "CLEAR", ambiguous: false, nameMismatch: true });
  });

  it("compares names loosely: case, accents, punctuation, a middle name", async () => {
    for (const name of ["dana director", "DANA  DIRECTOR", "Dana M. Director", "Director, Dana"]) {
      const result = await directorBackgroundStatesByEmail(typed(name), NOW, database([person("p1", "Dana", "Director", "2030-01-02")]));
      expect(result.get(directorMatchKey(EMAIL, name))?.nameMismatch, name).toBe(false);
    }
    const accented = await directorBackgroundStatesByEmail(typed("Zoe O'Brien-Núñez"), NOW, database([person("p1", "Zoé", "OBrien-Nunez", "2030-01-02")]));
    expect(accented.get(directorMatchKey(EMAIL, "Zoe O'Brien-Núñez"))?.nameMismatch).toBe(false);
  });

  it("does not call it a mismatch when at least one of several matched people has the name", async () => {
    const result = await directorBackgroundStatesByEmail(typed(), NOW, database([
      person("p1", "Robert", "Stranger", "2030-01-02"),
      person("p2", "Dana", "Director", null),
    ]));
    expect(result.get(KEY)).toEqual({ state: "NO_RECORD", ambiguous: true, nameMismatch: false });
  });

  it("matches a person through a linked attendee account's email", async () => {
    const linked = person("p1", "Dana", "Director", "2030-01-02", { normalizedEmail: null, attendeeAccountLinks: [{ account: { email: EMAIL } }] });
    const result = await directorBackgroundStatesByEmail(typed(), NOW, database([linked]));
    expect(result.get(KEY)).toMatchObject({ state: "CLEAR" });
  });

  it("judges each typed name on its own when two applications share an email", async () => {
    const result = await directorBackgroundStatesByEmail(
      [{ email: EMAIL, name: "Dana Director" }, { email: EMAIL, name: "Someone Else" }],
      NOW,
      database([person("p1", "Dana", "Director", "2030-01-02")]),
    );
    expect(result.get(directorMatchKey(EMAIL, "Dana Director"))?.nameMismatch).toBe(false);
    expect(result.get(directorMatchKey(EMAIL, "Someone Else"))?.nameMismatch).toBe(true);
  });
});
