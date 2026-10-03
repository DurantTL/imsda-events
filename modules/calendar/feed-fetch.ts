import "server-only";

import { lookup as dnsLookup, promises as dnsPromises } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { maxFeedBytes } from "@/modules/calendar/ics-import";

/**
 * Fetching a calendar feed on staff's behalf (#444 part B). The address is
 * typed in by a staff member, so it is treated as untrusted: only public https
 * hosts, no credentials, no private or internal addresses (checked on the name
 * and again on every connection, so a changing DNS answer can't slip past), a
 * short timeout, a body cap, and a few re-validated redirects. Nothing here
 * ever puts the address in an error, a log, or a return value.
 */

export class FeedFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedFetchError";
  }
}

export const fetchTimeoutMs = 10_000;
export const maxRedirects = 3;

function ipv4Parts(address: string) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function blockedIpv4([a, b, c]: number[]) {
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, including cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands "::" so an IPv6 address becomes eight 16-bit groups, or null when malformed. */
function ipv6Groups(address: string) {
  let text = address.toLowerCase().split("%")[0];
  const embedded = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) {
    const v4 = ipv4Parts(embedded[1]);
    if (!v4) return null;
    text = text.slice(0, -embedded[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/** True for any address a feed must never be fetched from: private, loopback, link-local, CGNAT, reserved, or malformed. */
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const parts = ipv4Parts(address);
    return !parts || blockedIpv4(parts);
  }
  if (kind === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return true;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
    const embeddedV4 = [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255];
    if (groups.every((group) => group === 0)) return true; // ::
    if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return true; // ::1
    // ::ffff:0:0/96 (IPv4-mapped) and ::/96 (IPv4-compatible): a public host never resolves to these.
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return true;
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // 64:ff9b:1::/48 local-use NAT64
    if (g0 === 0x64 && g1 === 0xff9b) return blockedIpv4(embeddedV4); // NAT64
    if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard-only
    if (g0 === 0x2001 && g1 === 0) return true; // 2001::/32 Teredo
    if (g0 === 0x2002) return blockedIpv4([g1 >> 8, g1 & 255, g2 >> 8]); // 6to4
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
    if ((g0 & 0xff00) === 0xff00) return true; // multicast
    if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
    return false;
  }
  return true;
}

const generic = {
  invalid: "That is not a valid calendar address. Use the https:// (or webcal://) address of the calendar.",
  unreachable: "The feed could not be reached.",
};

/**
 * The https URL to fetch, from what staff typed. webcal:// is https://.
 * Throws a `FeedFetchError` with a message that never repeats the address.
 */
export function normalizeFeedUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) throw new FeedFetchError(generic.invalid);
  const rewritten = trimmed.replace(/^webcals?:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(rewritten);
  } catch {
    throw new FeedFetchError(generic.invalid);
  }
  if (url.protocol !== "https:") throw new FeedFetchError("Calendar addresses must use https:// (or webcal://).");
  if (url.username || url.password) throw new FeedFetchError("Calendar addresses can't contain a user name or password.");
  if (url.port && url.port !== "443") throw new FeedFetchError("Calendar addresses must use the standard https port.");
  assertPublicHostname(url.hostname);
  return url;
}

function assertPublicHostname(hostnameRaw: string) {
  const hostname = hostnameRaw.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new FeedFetchError("That calendar address points to a private or internal network.");
    return;
  }
  // Numeric forms like 2130706433 or 0x7f.1 are parsed by WHATWG URL into dotted form above; anything left must be a real name.
  if (
    !hostname.includes(".") ||
    hostname === "localhost" ||
    /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(hostname)
  ) {
    throw new FeedFetchError("That calendar address points to a private or internal network.");
  }
}

export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (hostname) => {
  const records = await dnsPromises.lookup(hostname, { all: true });
  return records.map((record) => record.address);
};

/** Every address the name resolves to must be public. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new FeedFetchError("The feed took too long to respond."));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

async function assertResolvesPublic(url: URL, resolve: HostResolver, signal: AbortSignal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return;
  let addresses: string[];
  try {
    addresses = await abortable(resolve(hostname), signal);
  } catch (error) {
    if (error instanceof FeedFetchError) throw error;
    throw new FeedFetchError(generic.unreachable);
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new FeedFetchError("That calendar address points to a private or internal network.");
  }
}

export type TransportResponse = { status: number; location: string | null; body: string };
export type FeedTransport = (url: URL, signal: AbortSignal) => Promise<TransportResponse>;

/**
 * The real network call. A custom `lookup` re-checks the address at connect
 * time, so the connection can only go to the address that was validated.
 */
export const httpsTransport: FeedTransport = (url, signal) => new Promise((resolve, reject) => {
  const fail = () => reject(new FeedFetchError(generic.unreachable));
  const request = httpsRequest({
    protocol: "https:",
    hostname: url.hostname.replace(/^\[|\]$/g, ""),
    port: 443,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: { Accept: "text/calendar, text/plain;q=0.8, */*;q=0.1", "User-Agent": "IMSDA-Events-Calendar-Import", "Accept-Encoding": "identity" },
    lookup: (hostname, options, callback) => {
      dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
        const list = Array.isArray(addresses) ? addresses : [];
        if (error || list.length === 0 || list.some((entry) => isBlockedAddress(entry.address))) {
          const blocked = new Error("blocked") as NodeJS.ErrnoException;
          blocked.code = "ECONNREFUSED";
          (callback as unknown as (error: Error) => void)(blocked);
          return;
        }
        if (options.all) (callback as unknown as (error: null, addresses: typeof list) => void)(null, list);
        else (callback as unknown as (error: null, address: string, family: number) => void)(null, list[0].address, list[0].family);
      });
    },
  }, (response) => {
    const status = response.statusCode ?? 0;
    const location = typeof response.headers.location === "string" ? response.headers.location : null;
    if (status >= 300 && status < 400) {
      response.resume();
      resolve({ status, location, body: "" });
      return;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      resolve({ status, location: null, body: "" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxFeedBytes) {
        request.destroy();
        reject(new FeedFetchError("The calendar file is larger than the 2 MB limit."));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve({ status, location: null, body: Buffer.concat(chunks).toString("utf8") }));
    response.on("error", fail);
  });
  request.on("error", fail);
  const abort = () => {
    request.destroy();
    fail();
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  request.end();
});

/**
 * Fetches the feed text. `redirect: manual` in spirit: each hop is re-validated
 * as if it were a new address, up to three. The messages never contain the URL.
 */
export async function fetchFeedText(
  rawUrl: string,
  deps: { transport?: FeedTransport; resolve?: HostResolver; timeoutMs?: number } = {},
): Promise<string> {
  const transport = deps.transport ?? httpsTransport;
  const resolve = deps.resolve ?? defaultResolver;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? fetchTimeoutMs);
  try {
    let url = normalizeFeedUrl(rawUrl);
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      await assertResolvesPublic(url, resolve, controller.signal);
      let response: TransportResponse;
      try {
        response = await transport(url, controller.signal);
      } catch (error) {
        if (error instanceof FeedFetchError) throw error;
        throw new FeedFetchError(controller.signal.aborted ? "The feed took too long to respond." : generic.unreachable);
      }
      if (response.status >= 300 && response.status < 400) {
        if (!response.location || hop === maxRedirects) throw new FeedFetchError("The feed redirected too many times.");
        try {
          url = normalizeFeedUrl(new URL(response.location, url).toString());
        } catch (error) {
          if (error instanceof FeedFetchError) throw error;
          throw new FeedFetchError(generic.invalid);
        }
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new FeedFetchError(`The feed could not be reached (HTTP ${response.status}).`);
      }
      return response.body;
    }
    throw new FeedFetchError("The feed redirected too many times.");
  } finally {
    clearTimeout(timer);
  }
}

/** The only form of a feed address ever shown back: the host and the last four characters. */
export function feedUrlHint(url: URL) {
  const tail = `${url.pathname}${url.search}`.slice(-4);
  return `${url.hostname}…${tail}`;
}
