import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { isLockTimeoutError } from "@/lib/prisma-errors";

/** The lock-timeout shapes Prisma surfaces for SQLSTATE 55P03 (#157, #152). */
describe("isLockTimeoutError", () => {
  it.each([
    ["a raw query (P2010 with meta.code)", new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `55P03`.", { code: "P2010", clientVersion: "test", meta: { code: "55P03" } })],
    ["a transaction failure naming it (P2034)", new Prisma.PrismaClientKnownRequestError("55P03 lock timeout", { code: "P2034", clientVersion: "test" })],
    ["a non-raw query (unknown request error, message only)", new Prisma.PrismaClientUnknownRequestError("Error occurred during query execution: ConnectorError(... code: \"55P03\", message: \"canceling statement due to lock timeout\" ...)", { clientVersion: "test" })],
    ["a plain error with the SQLSTATE", Object.assign(new Error("lock timeout"), { code: "55P03" })],
  ])("matches %s", (_label, error) => {
    expect(isLockTimeoutError(error)).toBe(true);
  });

  it.each([
    ["a unique violation", new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" })],
    ["another unknown request error", new Prisma.PrismaClientUnknownRequestError("connection reset", { clientVersion: "test" })],
    ["a plain error", new Error("boom")],
    ["a non-error", "55P03"],
  ])("does not match %s", (_label, error) => {
    expect(isLockTimeoutError(error)).toBe(false);
  });
});
