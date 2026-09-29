import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { isLockTimeoutError, isSerializationFailure } from "@/lib/prisma-errors";

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

/** A SERIALIZABLE transaction that lost a conflict (SQLSTATE 40001) is retried, however Prisma reports it (#599). */
describe("isSerializationFailure", () => {
  it.each([
    ["Prisma's own transaction failure (P2034)", new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock.", { code: "P2034", clientVersion: "test" })],
    ["a raw query, such as a location's row lock (P2010 with meta.code)", new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40001`.", { code: "P2010", clientVersion: "test", meta: { code: "40001" } })],
    ["a raw query naming it only in the message", new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40001`. Message: `could not serialize access`", { code: "P2010", clientVersion: "test" })],
    ["a non-raw query (unknown request error, message only)", new Prisma.PrismaClientUnknownRequestError("ConnectorError(... code: \"40001\", message: \"could not serialize access\" ...)", { clientVersion: "test" })],
    ["a plain error with the SQLSTATE", Object.assign(new Error("could not serialize"), { code: "40001" })],
  ])("matches %s", (_label, error) => {
    expect(isSerializationFailure(error)).toBe(true);
  });

  it.each([
    ["a unique violation", new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" })],
    ["a lock wait that gave up", new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `55P03`.", { code: "P2010", clientVersion: "test", meta: { code: "55P03" } })],
    ["another unknown request error", new Prisma.PrismaClientUnknownRequestError("connection reset", { clientVersion: "test" })],
    ["a plain error", new Error("boom")],
    ["a non-error", "40001"],
  ])("does not match %s", (_label, error) => {
    expect(isSerializationFailure(error)).toBe(false);
  });
});
