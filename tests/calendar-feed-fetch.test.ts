import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { FeedFetchError, feedUrlHint, fetchFeedText, isBlockedAddress, maxRedirects, normalizeFeedUrl, type FeedTransport } from "@/modules/calendar/feed-fetch";

const secretUrl = "https://calendar.example.test/ical/private-abc123SECRET/basic.ics";
const publicResolver = async () => ["93.184.216.34"];
const ok = (body = "BEGIN:VCALENDAR\r\nEND:VCALENDAR") => ({ status: 200, location: null, body });

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FeedFetchError);
    return (error as Error).message;
  }
  throw new Error("expected a FeedFetchError");
}

describe("feed address validation", () => {
  it.each([
    "127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:c0a8:0101::1", "ff02::1", "2001:db8::1",
    "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "::ffff:8.8.8.8", "::ffff:0:0", "64:ff9b:1::1", "100::1", "192.88.99.1",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.63.255.255", "2606:4700:4700::1111" ])("allows %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("rewrites webcal:// to https://", () => {
    expect(normalizeFeedUrl("webcal://calendar.example.test/ical/x/basic.ics").toString()).toBe("https://calendar.example.test/ical/x/basic.ics");
    expect(normalizeFeedUrl("WEBCAL://calendar.example.test/a.ics").protocol).toBe("https:");
  });

  it.each([
    ["http", "http://calendar.example.test/a.ics"],
    ["credentials", "https://user:pass@calendar.example.test/a.ics"],
    ["a username only", "https://user@calendar.example.test/a.ics"],
    ["a non-standard port", "https://calendar.example.test:8443/a.ics"],
    ["ftp", "ftp://calendar.example.test/a.ics"],
    ["file", "file:///etc/passwd"],
    ["loopback", "https://127.0.0.1/a.ics"],
    ["decimal loopback", "https://2130706433/a.ics"],
    ["hex loopback", "https://0x7f.0.0.1/a.ics"],
    ["private v4", "https://10.1.2.3/a.ics"],
    ["metadata", "https://169.254.169.254/latest/meta-data"],
    ["CGNAT", "https://100.64.1.1/a.ics"],
    ["IPv6 loopback", "https://[::1]/a.ics"],
    ["IPv6 unique local", "https://[fd00::1]/a.ics"],
    ["IPv6 link-local", "https://[fe80::1]/a.ics"],
    ["IPv4-mapped IPv6", "https://[::ffff:10.0.0.1]/a.ics"],
    ["localhost", "https://localhost/a.ics"],
    ["a .localhost name", "https://calendar.localhost/a.ics"],
    ["an internal name", "https://calendar.internal/a.ics"],
    ["a dotless name", "https://intranet/a.ics"],
    ["blank", "   "],
    ["not a URL", "not a url"],
  ])("rejects %s", (_label, url) => {
    expect(() => normalizeFeedUrl(url)).toThrow(FeedFetchError);
  });

  it("never repeats the address in an error", () => {
    for (const bad of [`http://user:SECRETpass@calendar.example.test/ical/private-abc123SECRET/basic.ics`, `https://10.0.0.1/private-abc123SECRET`]) {
      try {
        normalizeFeedUrl(bad);
      } catch (error) {
        expect((error as Error).message).not.toMatch(/SECRET|10\.0\.0\.1|calendar\.example/);
      }
    }
  });

  it("hints the host and last four characters only", () => {
    expect(feedUrlHint(new URL(secretUrl))).toBe("calendar.example.test….ics");
    expect(feedUrlHint(new URL(secretUrl))).not.toContain("SECRET");
  });
});

describe("fetching a feed", () => {
  it("returns the body from a public https host", async () => {
    const transport: FeedTransport = vi.fn(async () => ok("hello"));
    await expect(fetchFeedText(secretUrl, { transport, resolve: publicResolver })).resolves.toBe("hello");
    expect(vi.mocked(transport).mock.calls[0][0].protocol).toBe("https:");
  });

  it("refuses a name that resolves to a private address, before any request", async () => {
    const transport = vi.fn(async () => ok());
    for (const address of ["10.0.0.7", "127.0.0.1", "::1", "fd00::5", "169.254.169.254"]) {
      await failure(fetchFeedText(secretUrl, { transport, resolve: async () => [address] }));
    }
    // Any one private answer among public ones is enough to refuse.
    await failure(fetchFeedText(secretUrl, { transport, resolve: async () => ["93.184.216.34", "10.0.0.7"] }));
    expect(transport).not.toHaveBeenCalled();
  });

  it("follows up to three redirects, each re-validated", async () => {
    const hops = ["https://b.example.test/1", "https://c.example.test/2", "https://d.example.test/3"];
    let call = 0;
    const transport: FeedTransport = vi.fn(async () => (call < 3 ? { status: 302, location: hops[call++], body: "" } : ok("done")));
    await expect(fetchFeedText(secretUrl, { transport, resolve: publicResolver })).resolves.toBe("done");
    expect(call).toBe(maxRedirects);
  });

  it("stops after more than three redirects", async () => {
    const transport: FeedTransport = vi.fn(async () => ({ status: 302, location: "https://b.example.test/again", body: "" }));
    await failure(fetchFeedText(secretUrl, { transport, resolve: publicResolver }));
    expect(transport).toHaveBeenCalledTimes(maxRedirects + 1);
  });

  it.each([
    ["http", "http://b.example.test/x"],
    ["a private address", "https://192.168.0.9/x"],
    ["credentials", "https://u:p@b.example.test/x"],
    ["a name that resolves privately", "https://rebind.example.test/x"],
  ])("refuses a redirect to %s", async (_label, location) => {
    const transport = vi.fn<FeedTransport>(async (url) => (url.hostname === "calendar.example.test" ? { status: 301, location, body: "" } : ok("leaked")));
    const resolve = async (host: string) => (host === "rebind.example.test" ? ["10.9.9.9"] : ["93.184.216.34"]);
    await failure(fetchFeedText(secretUrl, { transport, resolve }));
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("reports an HTTP error without the address", async () => {
    const transport: FeedTransport = async () => ({ status: 404, location: null, body: "" });
    const message = await failure(fetchFeedText(secretUrl, { transport, resolve: publicResolver }));
    expect(message).toBe("The feed could not be reached (HTTP 404).");
  });

  it("hides a transport failure behind a generic message", async () => {
    const transport: FeedTransport = async () => {
      throw new Error(`connect ECONNREFUSED ${secretUrl}`);
    };
    const message = await failure(fetchFeedText(secretUrl, { transport, resolve: publicResolver }));
    expect(message).not.toMatch(/SECRET|calendar\.example/);
  });

  it("times out", async () => {
    const transport: FeedTransport = (_url, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const message = await failure(fetchFeedText(secretUrl, { transport, resolve: publicResolver, timeoutMs: 20 }));
    expect(message).toMatch(/too long/);
  });

  it("holds the overall deadline while DNS is still resolving", async () => {
    const transport = vi.fn(async () => ok());
    const hung = () => new Promise<string[]>(() => undefined);
    const message = await failure(fetchFeedText(secretUrl, { transport, resolve: hung, timeoutMs: 20 }));
    expect(message).toMatch(/too long/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("says nothing of the address when DNS fails", async () => {
    const message = await failure(fetchFeedText(secretUrl, { transport: async () => ok(), resolve: async () => { throw new Error("ENOTFOUND calendar.example.test"); } }));
    expect(message).toBe("The feed could not be reached.");
  });
});
