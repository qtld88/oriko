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

/**
 * Named entities worth carrying, not the full HTML5 set of 2231 names. A meta
 * tag is written by a serialiser, and serialisers reach for a numeric
 * reference outside this range, so the long tail buys nothing. An unrecognised
 * name is left standing rather than guessed at.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", shy: "­",
  ndash: "–", mdash: "—", hellip: "…", middot: "·", bull: "•",
  lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  laquo: "«", raquo: "»", prime: "′", Prime: "″", dagger: "†", Dagger: "‡",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×", divide: "÷",
  euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", micro: "µ",
  iexcl: "¡", iquest: "¿", szlig: "ß", frac12: "½", frac14: "¼", frac34: "¾",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ",
  ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", ntilde: "ñ",
  ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", yuml: "ÿ",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ",
  Ccedil: "Ç", Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë",
  Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï", Ntilde: "Ñ",
  Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø",
  Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý",
};

const ENTITY = /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Turns the entities in a meta tag back into the text they stand for.
 *
 * Numeric references are the ones that matter. Threads writes an accented name
 * as `Me&#x301;lenchon` and a French title as `Avis aux g&#xe9;nies`, and left
 * undecoded both reach the note, the file name and whatever model is asked to
 * sort it, as letters that spell nothing.
 *
 * One pass, never a chain of replaces: `&amp;quot;` has to come out as the six
 * characters `&quot;`, which is what the page meant, and a second pass over
 * the output would turn it into a bare quotation mark.
 *
 * The result is normalised to NFC, because a decoded combining accent composes
 * with the letter before it. `Me` + U+0301 and `Mé` look alike and are not the
 * same string, and the difference reaches file names and search.
 */
export function decodeEntities(value: string): string {
  return value
    .replace(ENTITY, (whole, body: string) => {
      if (body[0] !== "#") return NAMED_ENTITIES[body] ?? whole;

      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // A lone surrogate and anything past the last plane denote no character,
      // and fromCodePoint throws on them rather than returning one.
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    })
    .normalize("NFC");
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

/**
 * Pulls the page's declared social preview image. Nearly every modern site
 * publishes one, which makes it the best single cover for a clipping whose
 * body carries no usable image of its own.
 */
export function extractPageImage(html: string, baseUrl: string): string | null {
  const found = readMetaTags(html);
  const raw = found.get("og:image") ?? found.get("og:image:url") ?? found.get("twitter:image");
  if (!raw) return null;

  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
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
