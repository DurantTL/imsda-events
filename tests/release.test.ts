import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getReleaseIdentity } from "@/lib/release";

describe("release identity", () => {
  it("accepts a deployment SHA and rejects arbitrary environment text", () => {
    expect(getReleaseIdentity({
      NODE_ENV: "test",
      APP_RELEASE_SHA: "d27839dcabf253111bf4a014cb526db3b1c57469",
    } as NodeJS.ProcessEnv).sha).toBe("d27839dcabf253111bf4a014cb526db3b1c57469");
    expect(getReleaseIdentity({
      NODE_ENV: "test",
      APP_RELEASE_SHA: "not a commit",
    } as NodeJS.ProcessEnv).sha).toBeNull();
  });

  it("uses xCloud's deployed commit when the portable variable is absent", () => {
    expect(getReleaseIdentity({
      NODE_ENV: "test",
      XCLOUD_DEPLOYED_COMMIT: "d27839dc Merge pull request",
    } as NodeJS.ProcessEnv).sha).toBe("d27839dc");
  });
});
