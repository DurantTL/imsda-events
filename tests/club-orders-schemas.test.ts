import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { parseExtrasQuery } from "@/modules/club-orders/schemas";

/** The extras on a top-level export link (#487): checked with the same schema placing the order uses. */
describe("parseExtrasQuery (#487)", () => {
  const parse = (query: string) => parseExtrasQuery(new URLSearchParams(query));

  it("reads repeated extra=<itemId>:<count> parameters", () => {
    expect(parse("view=readable&extra=item-1:2&extra=item-2:0")).toEqual({ "item-1": 2, "item-2": 0 });
    expect(parse("view=readable")).toEqual({});
  });

  it.each([
    "extra=item-1:-1",
    "extra=item-1:1.5",
    "extra=item-1:abc",
    "extra=item-1",
    "extra=:3",
    "extra=item-1:10001",
    "extra=item-1:2&extra=item-1:3",
  ])("refuses %s", (query) => {
    expect(() => parse(query)).toThrow(ZodError);
  });
});
