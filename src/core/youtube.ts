import { decodeEntities } from "./page-cover";

/**
 * What a YouTube page's Open Graph tags leave out: the description in full
 * (the tags cut it at 160 characters and fold its lines into one) and the
 * spoken words. Both come from the player endpoint the YouTube apps use.
 *
 * The Android client is the one asked because its caption URLs are served
 * as they are, where the web client's now demand a token only a browser
 * running YouTube's own scripts can mint.
 */
export const YOUTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

export function youtubePlayerBody(videoId: string): string {
  return JSON.stringify({
    context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
    videoId,
  });
}

export interface YouTubeDetails {
  title: string;
  author: string;
  description: string;
  /** The caption track to fetch, "" when the video has none. */
  captionUrl: string;
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

export function parsePlayerResponse(json: unknown): YouTubeDetails | null {
  const response = json as {
    videoDetails?: { title?: string; author?: string; shortDescription?: string };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
  } | null;
  const details = response?.videoDetails;
  if (!details) return null;
  const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return {
    title: details.title ?? "",
    author: details.author ?? "",
    description: details.shortDescription ?? "",
    captionUrl: pickTrack(tracks)?.baseUrl ?? "",
  };
}

/**
 * Captions someone wrote win over the machine's, but only in the language
 * the video is spoken in: the automatic track is the one that says which
 * language that is, and a channel's English subtitles on a French talk
 * are a translation, not a transcript.
 */
function pickTrack(tracks: CaptionTrack[]): CaptionTrack | undefined {
  const usable = tracks.filter((track) => track.baseUrl);
  const automatic = usable.find((track) => track.kind === "asr");
  const written = usable.filter((track) => track.kind !== "asr");
  if (!automatic) return written[0];
  return written.find((track) => track.languageCode === automatic.languageCode) ?? automatic;
}

export interface Cue {
  /** Seconds from the start of the video. */
  start: number;
  text: string;
}

/**
 * Reads a caption track. YouTube serves two shapes: srv3, with a <p> per cue
 * in milliseconds and the words split into <s> runs, and the older format
 * with a <text> per cue in seconds.
 */
export function parseCaptions(xml: string): Cue[] {
  const cues: Cue[] = [];
  const srv3 = /<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  const legacy = /<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  const modern = xml.includes("<timedtext format=\"3\"");
  const pattern = modern ? srv3 : legacy;
  for (const match of xml.matchAll(pattern)) {
    const start = Number(match[1]) / (modern ? 1000 : 1);
    // Entities are decoded twice on purpose: the legacy format escapes the
    // caption's own markup, so `&amp;#39;` is what an apostrophe looks like.
    const text = decodeEntities(decodeEntities(match[2].replace(/<[^>]+>/g, "")))
      .replace(/\s+/g, " ")
      .trim();
    if (text) cues.push({ start, text });
  }
  return cues;
}

/** A paragraph closes at the first sentence end after this many seconds… */
const PARAGRAPH_SOFT_S = 20;
/** …or here regardless, since automatic captions often have no punctuation. */
const PARAGRAPH_HARD_S = 45;

/**
 * The transcript as the note shows it: paragraphs of a sentence or a few,
 * each led by the time it starts at, the way Obsidian Web Clipper writes it.
 */
export function transcriptMarkdown(cues: Cue[]): string {
  const paragraphs: string[] = [];
  let start = 0;
  let words: string[] = [];

  const close = (): void => {
    if (words.length > 0) paragraphs.push(`**${timestamp(start)}** · ${words.join(" ")}`);
    words = [];
  };

  for (const cue of cues) {
    if (words.length === 0) start = cue.start;
    words.push(cue.text);
    const elapsed = cue.start - start;
    if (elapsed >= PARAGRAPH_HARD_S || (elapsed >= PARAGRAPH_SOFT_S && /[.!?…]$/.test(cue.text))) {
      close();
    }
  }
  close();
  return paragraphs.join("\n\n");
}

function timestamp(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
