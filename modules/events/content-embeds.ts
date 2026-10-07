/**
 * Video and map embeds for the public event page (#816).
 *
 * An embed is stored as a provider and an id, never as a pasted iframe or an
 * arbitrary address. The iframe `src` is built here, on the server, from a
 * fixed allowlist of origins, and an id is checked against a strict pattern
 * for its provider, so no stored value can point a frame anywhere else. The
 * same origins are the only ones the public event page's `frame-src` adds
 * (next.config.ts); a test keeps the two lists in step.
 */

export const embedProviders = ["YOUTUBE", "VIMEO", "GOOGLE_MAPS"] as const;
export type EmbedProvider = (typeof embedProviders)[number];

export const embedProviderLabels: Record<EmbedProvider, string> = {
  YOUTUBE: "YouTube video",
  VIMEO: "Vimeo video",
  GOOGLE_MAPS: "Google Maps",
};

/** The only origins an embedded frame may load from. */
export const embedFrameOrigins = [
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://www.google.com",
] as const;

const originByProvider: Record<EmbedProvider, string> = {
  YOUTUBE: "https://www.youtube-nocookie.com",
  VIMEO: "https://player.vimeo.com",
  GOOGLE_MAPS: "https://www.google.com",
};

/**
 * Per-provider id shapes. A Maps embed is identified by the long `pb` value
 * Google gives under Share, then Embed a map; its character set is limited to
 * what that value uses, so no `&`, `?`, `#`, quote, or space can end the value
 * and smuggle in another parameter.
 */
const idPatterns: Record<EmbedProvider, RegExp> = {
  YOUTUBE: /^[A-Za-z0-9_-]{11}$/,
  VIMEO: /^\d{5,12}$/,
  GOOGLE_MAPS: /^!1[A-Za-z0-9!_.\-%]{20,1500}$/,
};

export function isEmbedProvider(value: unknown): value is EmbedProvider {
  return typeof value === "string" && (embedProviders as readonly string[]).includes(value);
}

export function isValidEmbedId(provider: EmbedProvider, id: string) {
  return idPatterns[provider].test(id);
}

/** The iframe address for a stored embed, or null when it does not validate. */
export function embedSrc(provider: EmbedProvider, id: string): string | null {
  if (!isEmbedProvider(provider) || !isValidEmbedId(provider, id)) return null;
  const origin = originByProvider[provider];
  switch (provider) {
    case "YOUTUBE":
      return `${origin}/embed/${id}?rel=0`;
    case "VIMEO":
      return `${origin}/video/${id}?dnt=1`;
    case "GOOGLE_MAPS":
      return `${origin}/maps/embed?pb=${id}`;
  }
}

export type EmbedReference =
  | { ok: true; id: string }
  | { ok: false; message: string };

const youtubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const vimeoHosts = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);
const mapsHosts = new Set(["google.com", "www.google.com"]);

/**
 * Turns what staff paste into an id. It accepts a bare id or a page address on
 * the provider's own host, and nothing else: a pasted `<iframe>`, another
 * site's address, or a look-alike host is refused rather than reduced to
 * whatever id-shaped text it contains.
 */
export function extractEmbedId(provider: EmbedProvider, input: string): EmbedReference {
  const value = input.trim();
  if (!value) return { ok: false, message: "Paste the link or the id." };
  if (/[<>"'\s]/.test(value)) {
    return { ok: false, message: "Paste a link or an id, not embed code." };
  }
  if (isValidEmbedId(provider, value)) return { ok: true, id: value };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: `That is not a ${embedProviderLabels[provider]} link or id.` };
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return { ok: false, message: "Use a complete https:// link." };
  }
  const host = url.hostname.toLowerCase();
  let candidate: string | null = null;
  if (provider === "YOUTUBE") {
    if (host === "youtu.be") {
      candidate = url.pathname.split("/")[1] ?? null;
    } else if (youtubeHosts.has(host)) {
      const segments = url.pathname.split("/").filter(Boolean);
      if (url.pathname === "/watch") candidate = url.searchParams.get("v");
      else if (segments[0] === "embed" || segments[0] === "shorts" || segments[0] === "live") candidate = segments[1] ?? null;
    }
  } else if (provider === "VIMEO") {
    if (vimeoHosts.has(host)) {
      const segments = url.pathname.split("/").filter(Boolean);
      candidate = segments[0] === "video"
        ? segments[1] ?? null
        : segments.find((segment) => /^\d+$/.test(segment)) ?? null;
    }
  } else if (mapsHosts.has(host) && url.pathname === "/maps/embed") {
    // Raw, not decoded: the value legitimately carries %-escapes that must
    // stay exactly as Google issued them.
    candidate = /[?&]pb=([^&#]+)/.exec(url.search)?.[1] ?? null;
  }
  if (candidate && isValidEmbedId(provider, candidate)) return { ok: true, id: candidate };
  return {
    ok: false,
    message: provider === "GOOGLE_MAPS"
      ? "In Google Maps choose Share, then Embed a map, and paste the address from the embed code (it starts with https://www.google.com/maps/embed?pb=)."
      : `That is not a ${embedProviderLabels[provider]} link. Only ${provider === "YOUTUBE" ? "youtube.com or youtu.be" : "vimeo.com"} links work.`,
  };
}
