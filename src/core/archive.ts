import { readDimensions } from "./dimensions";
import { defaultExtension } from "./formats";
import { hashUrl } from "./hash";
import type { CanonicalMedia } from "./normalize";

export interface FetchResult {
  status: number;
  arrayBuffer: ArrayBuffer;
  contentType?: string;
}

export type Fetcher = (
  url: string,
  headers: Record<string, string>
) => Promise<FetchResult>;

export interface ArchiveDeps {
  fetch: Fetcher;
  exists: (path: string) => Promise<boolean>;
  write: (path: string, data: ArrayBuffer) => Promise<void>;
  folder: string;
  maxBytes: number;
  /** The note the media belongs to, whose name the files carry. */
  note?: string;
}

export interface ArchiveOutcome {
  key: string;
  kind: "image" | "video";
  file?: string;
  width?: number;
  height?: number;
  bytes?: number;
  failed?: string;
}

/**
 * Extensions a source-video download can land under, mp4 first because that
 * is what yt-dlp is asked for. Ordered, so the first existing candidate wins.
 */
const SOURCE_VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "m4v", "mkv"];

/**
 * Every path a source video for this key could live at. Caches are
 * per-device but the attachment folder syncs, so a device that cannot run
 * yt-dlp can still adopt the file another device downloaded.
 */
export function sourceVideoCandidates(key: string, folder: string, note = ""): string[] {
  const hash = hashUrl(key);
  const named = noteFilePrefix(note);
  const legacy = SOURCE_VIDEO_EXTENSIONS.map((ext) => `${folder}/${hash}-video.${ext}`);
  if (!named) return legacy;
  return [...SOURCE_VIDEO_EXTENSIONS.map((ext) => `${folder}/${named} ${hash}.${ext}`), ...legacy];
}

/** Where a source video downloaded for this note lands. */
export function sourceVideoPath(key: string, folder: string, extension: string, note = ""): string {
  const hash = hashUrl(key);
  const named = noteFilePrefix(note);
  return named ? `${folder}/${named} ${hash}.${extension}` : `${folder}/${hash}-video.${extension}`;
}

/** Statuses that hotlink protection returns and that a Referer may fix. */
const RETRYABLE = new Set([401, 403, 429]);
const UNSAFE_CHARS = /[^a-zA-Z0-9._-]/g;
const MAX_BASENAME = 80;
/** Characters a vault file name or a wikilink cannot carry. */
const UNSAFE_NOTE_CHARS = /[\\/:*?"<>|#^[\]]/g;
const MAX_NOTE_PREFIX = 60;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The note's name made safe to start a file name with, or "" when nothing
 * of it survives.
 */
export function noteFilePrefix(note: string): string {
  return note
    .replace(UNSAFE_NOTE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE_PREFIX)
    .trim();
}

/**
 * `<note name> <12 hex of the normalized url>.<ext>`, so a file says which
 * clipping it belongs to. Without a note it is the older
 * `<12 hex>-<original basename>`. The hash comes from the normalized key, so
 * every size variant of one asset maps to one file, and two media of one
 * note never share a name.
 */
export function archiveFilename(media: CanonicalMedia, note = ""): string {
  let base = "";
  try {
    base = decodeURIComponent(new URL(media.url).pathname.split("/").pop() ?? "");
  } catch {
    base = "";
  }
  base = base.replace(UNSAFE_CHARS, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!base) base = "media";

  if (!/\.[a-z0-9]{2,5}$/i.test(base)) {
    base += `.${defaultExtension(media.kind)}`;
  }
  const named = noteFilePrefix(note);
  if (named) return `${named} ${hashUrl(media.key)}${base.slice(base.lastIndexOf("."))}`;

  if (base.length > MAX_BASENAME) {
    const dot = base.lastIndexOf(".");
    base = base.slice(0, 60) + base.slice(dot);
  }
  return `${hashUrl(media.key)}-${base}`;
}

/** Downloads and validates one URL. Returns a reason string on failure. */
async function attempt(
  url: string,
  referer: string,
  deps: ArchiveDeps
): Promise<FetchResult | string> {
  let response: FetchResult;
  try {
    response = await deps.fetch(url, {});
    if (RETRYABLE.has(response.status) && referer) {
      response = await deps.fetch(url, { Referer: referer });
    }
  } catch (error) {
    return errorMessage(error);
  }

  if (response.status < 200 || response.status >= 300) return `HTTP ${response.status}`;

  // A clipping can point markdown image syntax at a web page. Trust the
  // server's content type over the markup that referenced it.
  const contentType = response.contentType?.split(";")[0]?.trim().toLowerCase();
  if (contentType && !/^(image|video)\//.test(contentType)) {
    return `unexpected content type ${contentType}`;
  }

  const bytes = response.arrayBuffer.byteLength;
  if (bytes === 0) return "empty response";
  if (bytes > deps.maxBytes) return `too large (${bytes} bytes)`;

  return response;
}

export async function archiveOne(
  media: CanonicalMedia,
  referer: string,
  deps: ArchiveDeps
): Promise<ArchiveOutcome> {
  const base: ArchiveOutcome = { key: media.key, kind: media.kind };
  const candidates = [media.url, ...(media.fallbacks ?? [])];

  const pathFor = (url: string, note = deps.note ?? ""): string =>
    `${deps.folder}/${archiveFilename({ ...media, url }, note)}`;

  // A copy archived before files carried their note's name is adopted as is.
  for (const url of candidates) {
    for (const path of new Set([pathFor(url), pathFor(url, "")])) {
      if (await deps.exists(path)) return { ...base, file: path };
    }
  }

  let lastFailure = "no source url";

  for (const url of candidates) {
    const result = await attempt(url, referer, deps);
    if (typeof result === "string") {
      lastFailure = result;
      continue;
    }

    const path = pathFor(url);
    try {
      await deps.write(path, result.arrayBuffer);
    } catch (error) {
      return { ...base, failed: errorMessage(error) };
    }

    const dimensions = media.kind === "image" ? readDimensions(result.arrayBuffer) : null;
    return {
      ...base,
      file: path,
      bytes: result.arrayBuffer.byteLength,
      width: dimensions?.width,
      height: dimensions?.height,
    };
  }

  return { ...base, failed: lastFailure };
}

export async function archiveAll(
  list: CanonicalMedia[],
  referer: string,
  deps: ArchiveDeps,
  concurrency = 4,
  onItemDone?: (completed: number, total: number) => void
): Promise<ArchiveOutcome[]> {
  const results = new Array<ArchiveOutcome>(list.length);
  let cursor = 0;
  let completed = 0;

  const worker = async (): Promise<void> => {
    while (cursor < list.length) {
      const index = cursor++;
      results[index] = await archiveOne(list[index], referer, deps);
      completed++;
      onItemDone?.(completed, list.length);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, worker);
  await Promise.all(workers);
  return results;
}
