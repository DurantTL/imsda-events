import { describe, expect, it } from "vitest";
import { createOpaqueToken, hashOpaqueToken } from "@/modules/access/tokens";

describe("opaque session tokens", () => {
  it("creates high-entropy tokens and stores only a one-way digest", () => {
    const first = createOpaqueToken();
    const second = createOpaqueToken();
    expect(first).not.toBe(second);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(hashOpaqueToken(first)).toHaveLength(64);
    expect(hashOpaqueToken(first)).not.toContain(first);
  });
});
