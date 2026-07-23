import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  identitiesDescribeSamePerson,
  registrationOperationFingerprint,
} from "@/modules/registrations/operations-domain";

describe("registration operation domain", () => {
  it("creates a stable fingerprint independent of object key order", () => {
    const first = registrationOperationFingerprint({
      eventId: "event-1",
      registrationId: "registration-1",
      operation: "TRANSFER",
      payload: {
        email: "new@example.test",
        firstName: "New",
        nested: { z: 2, a: 1 },
      },
    });
    const replay = registrationOperationFingerprint({
      registrationId: "registration-1",
      eventId: "event-1",
      operation: "TRANSFER",
      payload: {
        nested: { a: 1, z: 2 },
        firstName: "New",
        email: "new@example.test",
      },
    });
    const changed = registrationOperationFingerprint({
      eventId: "event-1",
      registrationId: "registration-1",
      operation: "TRANSFER",
      payload: {
        email: "different@example.test",
        firstName: "New",
        nested: { z: 2, a: 1 },
      },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(replay).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("matches normalized party identities without treating shared names as duplicates when emails differ", () => {
    expect(identitiesDescribeSamePerson(
      {
        firstName: "  Avery ",
        lastName: "JOHNSON",
        email: "AVERY@example.test",
        phone: "",
      },
      {
        firstName: "avery",
        lastName: "johnson",
        email: "avery@example.test",
        phone: "",
      },
    )).toBe(true);
    expect(identitiesDescribeSamePerson(
      {
        firstName: "Avery",
        lastName: "Johnson",
        email: "parent@example.test",
        phone: "",
      },
      {
        firstName: "Avery",
        lastName: "Johnson",
        email: "child@example.test",
        phone: "",
      },
    )).toBe(false);
  });

  it("uses a phone or exact name when an attendee has no email", () => {
    expect(identitiesDescribeSamePerson(
      {
        firstName: "Jordan",
        lastName: "Lee",
        email: "",
        phone: "555-0100",
      },
      {
        firstName: "Jordan",
        lastName: "Lee",
        email: "",
        phone: "555-0100",
      },
    )).toBe(true);
    expect(identitiesDescribeSamePerson(
      {
        firstName: "Jordan",
        lastName: "Lee",
        email: "",
        phone: "",
      },
      {
        firstName: "Jordan",
        lastName: "Lee",
        email: "",
        phone: "",
      },
    )).toBe(true);
  });
});
