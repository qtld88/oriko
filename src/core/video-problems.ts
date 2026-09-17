/**
 * Why a post's own video did not make it into the vault, worded for a toast.
 *
 * Most failed video downloads are not worth mentioning: an Instagram carousel
 * of photos has no video to find, and yt-dlp says so every time. These three
 * are different, because each has something the user can do about it and
 * each otherwise looks exactly like a post with no video.
 */

export type VideoProblemKind = "refused" | "timed-out" | "too-large";

export interface VideoProblem {
  kind: VideoProblemKind;
  /** The page the video was fetched from. */
  source: string;
  /** The clipping's title, "" when no note exists yet. */
  title: string;
  /** How big the download came out, for too-large. */
  bytes?: number;
}

/**
 * Picks the problems worth telling the user about out of a failed yt-dlp
 * run. A 403 is the site turning the request away, which in practice means
 * the site changed and yt-dlp has not caught up yet.
 */
export function ytdlpProblem(stderr: string, timedOut: boolean): "refused" | "timed-out" | null {
  if (timedOut) return "timed-out";
  if (/HTTP Error 403/i.test(stderr)) return "refused";
  return null;
}

const TITLE_LENGTH = 40;
const SIZE_SETTING = "Settings → Oriko → Downloads → Maximum file size (MB)";

/** One message per kind of problem, so a pass over many clippings stays one toast each. */
export function describeVideoProblems(
  problems: VideoProblem[],
  limits: { maxBytes: number; timeoutMs: number }
): string[] {
  const messages: string[] = [];

  const refused = problems.filter((p) => p.kind === "refused");
  if (refused.length > 0) {
    // The site leads the sentence, so the subject never names it again.
    messages.push(
      `Oriko: ${sitesOf(refused)} refused to let yt-dlp download ${subject(refused, false)}. ` +
        "That usually means yt-dlp is out of date: update it, then run Download all clipping media."
    );
  }

  const timedOut = problems.filter((p) => p.kind === "timed-out");
  if (timedOut.length > 0) {
    messages.push(
      `Oriko: gave up on ${subject(timedOut, true)}${pause(timedOut)} after ${duration(limits.timeoutMs)}. ` +
        "Long videos can take longer than that to download."
    );
  }

  const tooLarge = problems.filter((p) => p.kind === "too-large");
  if (tooLarge.length > 0) {
    const size =
      tooLarge.length > 1
        ? "they're"
        : tooLarge[0].bytes !== undefined
          ? `at ${megabytes(tooLarge[0].bytes)} it's`
          : "it's";
    messages.push(
      `Oriko: skipped ${subject(tooLarge, true)}${pause(tooLarge)} because ${size} over your ` +
        `${megabytes(limits.maxBytes)} limit. You can raise the limit in ${SIZE_SETTING}.`
    );
  }

  return messages;
}

/** "the video for "…"", or "2 videos, including "…"" when several share a message. */
function subject(problems: VideoProblem[], nameSite: boolean): string {
  const titled = problems.find((p) => p.title.trim());
  if (problems.length > 1) {
    return titled
      ? `${problems.length} videos, including ${quoted(titled.title)}`
      : `${problems.length} videos`;
  }
  if (titled) return `the video for ${quoted(titled.title)}`;
  const site = nameSite ? siteOf(problems[0].source) : "";
  return site ? `the video from ${site}` : "the video";
}

/** Closes the "including …" aside when a clause follows the subject. */
function pause(problems: VideoProblem[]): string {
  return problems.length > 1 && problems.some((p) => p.title.trim()) ? "," : "";
}

function quoted(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= TITLE_LENGTH) return `"${trimmed}"`;
  // Trailing dots go, so a title that already trails off does not end "..…".
  return `"${trimmed.slice(0, TITLE_LENGTH).replace(/[\s.…]+$/, "")}…"`;
}

function siteOf(source: string): string {
  try {
    return new URL(source).hostname.replace(/^(www|m)\./, "");
  } catch {
    return "";
  }
}

function sitesOf(problems: VideoProblem[]): string {
  const sites = new Set(problems.map((p) => siteOf(p.source)));
  const [only] = sites;
  if (sites.size === 1) return only || "the site";
  return "the sites";
}

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1048576))} MB`;
}

function duration(ms: number): string {
  const minutes = ms / 60000;
  if (minutes >= 1 && Number.isInteger(minutes)) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${Math.round(ms / 1000)} seconds`;
}
