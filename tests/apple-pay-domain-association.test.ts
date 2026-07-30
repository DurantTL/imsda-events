import { beforeEach, describe, expect, it, vi } from "vitest";

const fetcher = vi.fn();
vi.stubGlobal("fetch", fetcher);

import { GET } from "@/app/.well-known/apple-developer-merchantid-domain-association/route";

beforeEach(() => {
  fetcher.mockReset();
});

describe("Apple Pay domain association", () => {
  it("serves Square's current extensionless verification payload", async () => {
    fetcher.mockResolvedValue(new Response("square-apple-association", {
      status: 200,
    }));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe("square-apple-association");
    expect(fetcher).toHaveBeenCalledWith(
      "https://app.squareup.com/digital-wallets/apple-pay/apple-developer-merchantid-domain-association",
      { next: { revalidate: 86_400 } },
    );
  });

  it("fails closed when Square does not provide a current payload", async () => {
    fetcher.mockResolvedValue(new Response("unavailable", { status: 503 }));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
