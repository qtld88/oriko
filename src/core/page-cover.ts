import { dedupeMedia, sourceVideoKeyFor } from "./normalize";
import type { MediaRef } from "./scan";

export interface ThumbnailCandidate {
  url: string;
  /** Tried in order when `url` is unavailable. */
  fallbacks: string[];
}

/** YouTube ids are exactly 11 characters of base64url. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
]);
const YOUTUBE_PATHS = /^\/(?:embed|shorts|v|live)\/([A-Za-z0-9_-]{11})/;

/**
 * Resolves a video page URL to its thumbnail without any network request.
 *
 * Clippings routinely reference a video by its page URL, sometimes with
 * markdown image syntax. Fetching that URL returns HTML, so the archiver
 * rejects it; this turns it into a real cover instead.
 */
export function knownHostThumbnail(pageUrl: string): ThumbnailCandidate | null {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  let id: string | null = null;

  if (host === "youtu.be") {
    id = parsed.pathname.slice(1).split("/")[0] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    id = parsed.searchParams.get("v") ?? YOUTUBE_PATHS.exec(parsed.pathname)?.[1] ?? null;
  }

  if (!id || !YOUTUBE_ID.test(id)) return null;

  // maxres exists only for videos uploaded at that resolution, so the
  // archiver walks down to sizes YouTube always generates.
  return {
    url: `https://img.youtube.com/vi/${id}/maxresdefault.jpg`,
    fallbacks: [
      `https://img.youtube.com/vi/${id}/hq720.jpg`,
      `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
    ],
  };
}

const META_TAG = /<meta\b[^>]*>/gi;
const META_KEY = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i;
const META_CONTENT = /\bcontent\s*=\s*["']([^"']*)["']/i;

export function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** Collects every og:/twitter: meta tag on a page, first declaration winning. */
export function readMetaTags(html: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const tag of html.matchAll(META_TAG)) {
    const key = META_KEY.exec(tag[0])?.[1]?.toLowerCase();
    if (!key) continue;
    const content = META_CONTENT.exec(tag[0])?.[1];
    if (!content || !content.trim()) continue;
    // First declaration wins: pages repeat og:image for extra sizes.
    if (!found.has(key)) found.set(key, decodeEntities(content.trim()));
  }

  return found;
}

/** Meta's CDNs, which serve Instagram, Threads and Facebook alike. */
const META_CDN = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

/**
 * Whether a URL is someone's profile picture rather than a picture of the
 * thing clipped. A Threads or Instagram post with no media of its own
 * publishes its author's face as og:image, and a clipper copies avatars into
 * the body beside the post, so without this a text post's tile is a portrait
 * of whoever wrote it. Read off the URL alone: Meta files a profile picture
 * under a `t51.<n>-19` rendition, and the other networks under a path of
 * their own.
 */
export function isAvatarUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  if (META_CDN.test(host)) return /\/t51\.\d+-19\//.test(path);
  if (host === "pbs.twimg.com") return path.startsWith("/profile_images/");
  if (host === "cdn.bsky.app") return path.startsWith("/img/avatar/");
  // Mastodon, on whichever instance.
  return path.includes("/accounts/avatars/");
}

/**
 * The page's declared social preview images, absolute, in the order a page
 * is read: og:image, then its aliases, then Twitter's.
 */
export function pageImages(html: string, baseUrl: string): string[] {
  const found = readMetaTags(html);
  const out: string[] = [];
  for (const name of ["og:image", "og:image:url", "twitter:image"]) {
    const raw = found.get(name);
    if (!raw) continue;
    try {
      const absolute = new URL(raw, baseUrl).toString();
      if (!out.includes(absolute)) out.push(absolute);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Pulls the page's declared social preview image. Nearly every modern site
 * publishes one, which makes it the best single cover for a clipping whose
 * body carries no usable image of its own. A profile picture is not one:
 * a page that offers nothing else has no cover.
 */
export function extractPageImage(html: string, baseUrl: string): string | null {
  return pageImages(html, baseUrl).find((url) => !isAvatarUrl(url)) ?? null;
}

/**
 * Whether a page cover is worth fetching for a clipping.
 *
 * The page cover is the last thing tile.ts reaches for, so it is only worth
 * a request while nothing ahead of it has been archived. Two things get
 * there first: an inline image from the clipping's own body, and a video
 * pulled from the post. The second is the one that used to be missed, and
 * on X it is the expensive miss, because the still a video post publishes
 * is a frame of the very video already on disk.
 *
 * @param archivedFile the cache's answer for a key: a local file, or
 * undefined. Passed as a function so this stays free of Obsidian imports.
 */
export function needsPageCover(
  record: { source: string; media: MediaRef[] },
  archivedFile: (key: string) => string | undefined
): boolean {
  if (!record.source) return false;
  // A file embedded from the vault is the clipping's own picture, and the
  // tile shows it ahead of anything fetched for the page.
  if (record.media.some((media) => !/^https?:\/\//i.test(media.url))) return false;
  if (archivedFile(sourceVideoKeyFor(record.source))) return false;
  return !dedupeMedia(record.media).some((media) => archivedFile(media.key));
}
