import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeError, logError, logWarn, requestCorrelationId } from "@/lib/logger";

/** Stands in for the application's own error classes, which are server-only. */
class MessagingError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "MessagingError";
  }
}

const lines: string[] = [];
let originalError: typeof console.error;
let originalWarn: typeof console.warn;

beforeEach(() => {
  lines.length = 0;
  originalError = console.error;
  originalWarn = console.warn;
  console.error = (line: string) => lines.push(line);
  console.warn = (line: string) => lines.push(line);
});

afterEach(() => {
  console.error = originalError;
  console.warn = originalWarn;
  vi.restoreAllMocks();
});

function lastLine() {
  return JSON.parse(lines[lines.length - 1]);
}

describe("redaction", () => {
  it("never lets a Prisma error message reach the log", () => {
    // A Prisma message embeds the failing query and its parameters, which for
    // this application can include medical and dietary answers.
    const error = new Prisma.PrismaClientKnownRequestError(
      'Invalid `prisma.registration.create()` invocation: medical_notes = "severe peanut allergy"',
      { code: "P2002", clientVersion: "6.19.3" },
    );

    logError("Registration request failed", error);
    const line = lines[lines.length - 1];

    expect(line).not.toContain("peanut");
    expect(line).not.toContain("prisma.registration.create");
    expect(lastLine().error).toEqual({
      name: "PrismaClientKnownRequestError",
      code: "P2002",
      redacted: true,
    });
  });

  it("never lets a Zod error echo the submitted value", () => {
    const error = new z.ZodError([]);
    Object.defineProperty(error, "message", {
      value: 'Invalid email: received "attendee@example.test"',
    });

    logError("Validation failed", error);

    expect(lines[lines.length - 1]).not.toContain("attendee@example.test");
    expect(lastLine().error.redacted).toBe(true);
  });

  it("keeps the message of an application error, which is operator-facing text", () => {
    logError("Processing failed", new MessagingError(
      "DELIVERY_DISABLED",
      "Message delivery is turned off for this event.",
    ));

    expect(lastLine().error).toEqual({
      name: "MessagingError",
      code: "DELIVERY_DISABLED",
      message: "Message delivery is turned off for this event.",
    });
  });

  it("redacts a plain Error, since its message is not written for a log", () => {
    expect(describeError(new Error("connect ECONNREFUSED 10.0.0.4:5432"))).toEqual({
      name: "Error",
      redacted: true,
    });
  });

  it("handles a thrown non-Error without crashing the logger", () => {
    expect(describeError("just a string")).toEqual({ name: "string", redacted: true });
    expect(describeError(null)).toEqual({ name: "object", redacted: true });
  });

  it("ignores an implausibly long code rather than logging it", () => {
    const error = Object.assign(new Error("boom"), { code: "x".repeat(200) });

    expect(describeError(error).code).toBeUndefined();
  });
});

describe("line shape", () => {
  it("emits one JSON object per call with a level, timestamp, and message", () => {
    logError("Check-in request failed", new Error("boom"), { eventId: "evt_wr26" });
    const line = lastLine();

    expect(lines).toHaveLength(1);
    expect(line.level).toBe("error");
    expect(line.msg).toBe("Check-in request failed");
    expect(line.eventId).toBe("evt_wr26");
    expect(Date.parse(line.time)).not.toBeNaN();
  });

  it("writes warnings at their own level", () => {
    logWarn("A published form has an invalid definition.", { formId: "form_1" });

    expect(lastLine()).toMatchObject({ level: "warn", formId: "form_1" });
  });
});

describe("correlation identifiers", () => {
  function withHeader(value: string | null) {
    return new Request("https://events.imsda.test/api/health", {
      headers: value === null ? {} : { "x-correlation-id": value },
    });
  }

  it("reuses a well-formed inbound identifier so one request can be followed end to end", () => {
    expect(requestCorrelationId(withHeader("req-9f8a-2026"))).toBe("req-9f8a-2026");
  });

  it("mints one when the proxy supplies none", () => {
    const id = requestCorrelationId(withHeader(null));

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toBe(requestCorrelationId(withHeader(null)));
  });

  it("refuses an attacker-controlled value that would forge log structure", () => {
    for (const hostile of ['a" ,"level":"info', "x".repeat(200), "id with spaces", ""]) {
      expect(requestCorrelationId(withHeader(hostile))).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
