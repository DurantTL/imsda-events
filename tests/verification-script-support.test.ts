import { describe, expect, it } from "vitest";
import { daysFromNow, futureEventWindow } from "../scripts/support/fixture-dates";
import { fillBlankSyntheticEnv } from "../scripts/support/synthetic-env";

describe("fillBlankSyntheticEnv", () => {
  it("fills an unset variable", () => {
    const env: Record<string, string | undefined> = {};
    fillBlankSyntheticEnv("KEY", "synthetic", env);
    expect(env.KEY).toBe("synthetic");
  });

  it("fills an empty string, which ??= would have kept", () => {
    const env: Record<string, string | undefined> = { KEY: "" };
    fillBlankSyntheticEnv("KEY", "synthetic", env);
    expect(env.KEY).toBe("synthetic");
  });

  it("treats whitespace as blank", () => {
    const env: Record<string, string | undefined> = { KEY: "   \t" };
    fillBlankSyntheticEnv("KEY", "synthetic", env);
    expect(env.KEY).toBe("synthetic");
  });

  it("keeps a real value", () => {
    const env: Record<string, string | undefined> = { KEY: "configured" };
    fillBlankSyntheticEnv("KEY", "synthetic", env);
    expect(env.KEY).toBe("configured");
  });

  it("refuses a blank synthetic value", () => {
    expect(() => fillBlankSyntheticEnv("KEY", "  ", {})).toThrow(/must not be blank/);
  });
});

describe("fixture dates", () => {
  const now = new Date("2030-01-10T08:00:00.000Z");

  it("computes dates relative to the given now at 21:00 UTC", () => {
    expect(daysFromNow(3, now).toISOString()).toBe("2030-01-13T21:00:00.000Z");
    expect(daysFromNow(-1, now).toISOString()).toBe("2030-01-09T21:00:00.000Z");
  });

  it("builds a future event window with the requested length", () => {
    const { startsAt, endsAt } = futureEventWindow(45, 2, now);
    expect(startsAt.getTime()).toBeGreaterThan(now.getTime());
    expect(endsAt.getTime() - startsAt.getTime()).toBe(2 * 24 * 60 * 60 * 1000);
    expect(startsAt.toISOString()).toBe("2030-02-24T21:00:00.000Z");
  });

  it("defaults to a window that has not started", () => {
    expect(futureEventWindow().startsAt.getTime()).toBeGreaterThan(Date.now());
  });
});
