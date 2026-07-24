import { afterEach, describe, expect, it, vi } from "vitest";
import { logError, logInfo } from "@/lib/logger";
import {
  CORRELATION_HEADER,
  currentCorrelationId,
  runWithRequestContext,
  withRequestContext,
} from "@/lib/request-context";

function capturedLines() {
  const lines: Array<Record<string, unknown>> = [];
  const record = (line: unknown) => { lines.push(JSON.parse(String(line))); };
  vi.spyOn(console, "log").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  return lines;
}

function request(headers: Record<string, string> = {}) {
  return new Request("https://events.imsda.test/api/events/evt_1/registrations", {
    method: "POST",
    headers,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request-scoped correlation", () => {
  it("puts one id on every line a request writes, without being passed one", async () => {
    const lines = capturedLines();

    const handler = withRequestContext(async () => {
      // Two different layers, neither of which was given the id.
      logInfo("first");
      logError("second", new Error("boom"));
      return Response.json({ ok: true });
    });
    await handler(request());

    expect(lines).toHaveLength(2);
    expect(lines[0].correlationId).toEqual(expect.any(String));
    expect(lines[1].correlationId).toBe(lines[0].correlationId);
    expect(lines[0]).toMatchObject({
      method: "POST",
      path: "/api/events/evt_1/registrations",
    });
  });

  it("echoes the id back so a person can quote it", async () => {
    const handler = withRequestContext(async () => Response.json({ ok: true }));

    const response = await handler(request());

    expect(response.headers.get(CORRELATION_HEADER)).toEqual(expect.any(String));
  });

  it("reuses an id the proxy supplied, so one request keeps one identity", async () => {
    const lines = capturedLines();
    const handler = withRequestContext(async () => {
      logInfo("inside");
      return Response.json({ ok: true });
    });

    const response = await handler(request({ [CORRELATION_HEADER]: "edge-1234" }));

    expect(response.headers.get(CORRELATION_HEADER)).toBe("edge-1234");
    expect(lines[0].correlationId).toBe("edge-1234");
  });

  it("refuses an inbound id that is too long or oddly shaped", async () => {
    // Attacker-controlled and lands in a log line, so it is bounded. A newline
    // is not tested here because the platform rejects such a header outright.
    for (const supplied of ["x".repeat(65), "not a valid id", "id;with-punctuation"]) {
      const handler = withRequestContext(async () => Response.json({ ok: true }));
      const response = await handler(request({ [CORRELATION_HEADER]: supplied }));
      expect(response.headers.get(CORRELATION_HEADER)).not.toBe(supplied);
    }
  });

  it("gives each request its own id", async () => {
    const handler = withRequestContext(async () => Response.json({ ok: true }));

    const [first, second] = await Promise.all([handler(request()), handler(request())]);

    expect(first.headers.get(CORRELATION_HEADER))
      .not.toBe(second.headers.get(CORRELATION_HEADER));
  });

  it("keeps concurrent requests from seeing each other's id", async () => {
    const seen: Array<string | undefined> = [];
    const handler = withRequestContext(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(currentCorrelationId());
      return Response.json({ ok: true });
    });

    const responses = await Promise.all([
      handler(request({ [CORRELATION_HEADER]: "one" })),
      handler(request({ [CORRELATION_HEADER]: "two" })),
    ]);

    expect(new Set(seen)).toEqual(new Set(["one", "two"]));
    expect(responses.map((response) => response.headers.get(CORRELATION_HEADER)))
      .toEqual(["one", "two"]);
  });

  it("logs nothing extra outside a request", () => {
    const lines = capturedLines();

    logInfo("background work");

    expect(lines[0]).not.toHaveProperty("correlationId");
  });

  it("still returns the response when a header cannot be attached", async () => {
    const lines = capturedLines();
    const immutable = new Response("{}", { status: 200 });
    Object.defineProperty(immutable, "headers", {
      value: { set() { throw new TypeError("immutable headers"); } },
    });

    const handler = withRequestContext(async () => immutable);

    expect(await handler(request())).toBe(immutable);
    expect(lines).toHaveLength(0);
  });

  it("exposes the id to code that wants it directly", () => {
    runWithRequestContext({ correlationId: "explicit-1" }, () => {
      expect(currentCorrelationId()).toBe("explicit-1");
    });
    expect(currentCorrelationId()).toBeUndefined();
  });
});
