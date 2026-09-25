import { todayISO } from "./dates";
import { extensionOf, kindForExtension } from "./formats";
import { isAvatarUrl } from "./page-cover";
import { domainOf, scanClipping } from "./scan";

/**
 * Brings a note written by hand, or by some other tool, up to the shape a
 * clipping has when Oriko writes it (see buildNote in resolve.ts), so a
 * folder of old notes can join the wall as if each had been clipped.
 *
 * Pure: the plan says what to add, and format-service.ts does the writing,
 * the downloading and the moving. Nothing here overwrites a value the note
 * already holds.
 */

/** Where the note's picture is to come from, if it needs one. */
export type PictureSource =
  /** It has a cover, or its first media is a video the tile already plays. */
  | { kind: "none" }
  /**
   * The first image in the body, remote or a vault embed. `pages` stand in
   * if it cannot be had.
   */
  | { kind: "body"; url: string; remote: boolean; pages: string[] }
  /**
   * Nothing in the body: the preview image of the first of these pages that
   * publishes one, the source first and then the links in the text.
   */
  | { kind: "page"; pages: string[] };

export interface ConformPlan {
  /** Keys to add to the frontmatter, with the value each is given. */
  add: Record<string, unknown>;
  /** `tags` as it should read, or null when it already carries clippings. */
  tags: string[] | null;
  picture: PictureSource;
  /** The cover the note holds is someone's profile picture: take it out. */
  dropCover: boolean;
  /** Append a link to the source at the end of the body. */
  linkSource: boolean;
}

export type Conformance =
  | { kind: "plan"; plan: ConformPlan }
  | { kind: "skip"; reason: string };

export const CLIPPING_TAG = "clippings";

/** The keys buildNote writes empty when it has nothing for them. */
const EMPTY_KEYS = ["source", "author", "published", "description"];

function basename(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.md$/i, "");
}

function present(value: unknown): boolean {
  return value !== undefined;
}

/** Reads `tags` in every shape a note carries it: a list, one string, or a comma list. */
export function tagsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((t) => t.trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

/** Links a redirect service wraps, with the real target in `u`. */
const REDIRECT_HOSTS = new Set(["l.threads.net", "l.instagram.com", "l.facebook.com", "lm.facebook.com"]);
const BARE_LINK = /https?:\/\/[^\s<>()[\]"'`]+/gi;
/** Pages are fetched one after another, so a note full of links stops here. */
const MAX_LINKS = 3;

/**
 * Pages linked from a note's text that could lend it a picture, in the order
 * they appear: not the source itself, nor anywhere on the source's own site,
 * which on Threads is only ever the author's and others' profiles, nor a
 * link straight to a media file, which the body scan already had its say on.
 */
export function linkedPages(body: string, source: string): string[] {
  const home = domainOf(source);
  const out: string[] = [];
  for (const match of body.matchAll(BARE_LINK)) {
    let url = match[0].replace(/[.,;:!?]+$/, "");
    try {
      const parsed = new URL(url);
      const wrapped = parsed.searchParams.get("u");
      if (REDIRECT_HOSTS.has(parsed.hostname.toLowerCase()) && wrapped) url = new URL(wrapped).toString();
    } catch {
      continue;
    }
    if (url === source || out.includes(url)) continue;
    if (home && domainOf(url) === home) continue;
    if (kindForExtension(extensionOf(url))) continue;
    out.push(url);
    if (out.length === MAX_LINKS) break;
  }
  return out;
}

function hasClippingTag(tags: string[]): boolean {
  return tags.some((tag) => tag.replace(/^#/, "").toLowerCase() === CLIPPING_TAG);
}

/**
 * What a note needs to become a clipping.
 *
 * @param created the file's creation time, stamped when the note has no
 * `created` of its own.
 * @param coverIsAvatar the caller found that the note's cover, a file in the
 * vault, was archived from a profile picture. A URL cover is checked here.
 */
export function planConformance(
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
  created: number,
  coverIsAvatar = false
): Conformance {
  const record = scanClipping(path, frontmatter, body);
  const source = typeof frontmatter.source === "string" ? frontmatter.source.trim() : "";
  const remoteSource = /^https?:\/\//i.test(source);

  const dropCover = Boolean(record.cover) && (coverIsAvatar || isAvatarUrl(record.cover));
  const cover = dropCover ? "" : record.cover;
  // A post that is only text still has its author's face beside it.
  const media = record.media.filter((m) => !isAvatarUrl(m.url));
  const pages = [...(remoteSource ? [source] : []), ...linkedPages(body, source)];

  let picture: PictureSource = { kind: "none" };
  if (!cover) {
    const first = media[0];
    if (first?.kind === "image") {
      picture = { kind: "body", url: first.url, remote: /^https?:\/\//i.test(first.url), pages };
    } else if (!first && pages.length > 0) {
      picture = { kind: "page", pages };
    }
  }

  // Nothing to show and nowhere to look for it: a wall tile needs a
  // picture, so a note like this would join the clippings and show nowhere.
  if (!cover && media.length === 0 && pages.length === 0) {
    return { kind: "skip", reason: "no source and no picture" };
  }

  const add: Record<string, unknown> = {};
  if (!present(frontmatter.title)) add.title = basename(path);
  for (const key of EMPTY_KEYS) {
    // Null writes as a bare `key:`, which is how buildNote leaves them;
    // description alone is written as an empty string there.
    if (!present(frontmatter[key])) add[key] = key === "description" ? "" : null;
  }
  if (!present(frontmatter.created)) add.created = todayISO(new Date(created));

  const held = tagsOf(frontmatter.tags);
  const tags = hasClippingTag(held) ? null : [...held, CLIPPING_TAG];

  const linkSource = remoteSource && !body.includes(source);

  return { kind: "plan", plan: { add, tags, picture, dropCover, linkSource } };
}

/** True when the plan changes nothing about the note itself. */
export function isEmptyPlan(plan: ConformPlan): boolean {
  return (
    Object.keys(plan.add).length === 0 &&
    plan.tags === null &&
    plan.picture.kind === "none" &&
    !plan.dropCover &&
    !plan.linkSource
  );
}

/**
 * Lines to append to the body. Existing text is never edited: `embed` is a
 * picture fetched from the page, since a body image is already in the body,
 * and the source is linked only when the body does not already name it.
 */
export function appendedBody(
  body: string,
  plan: ConformPlan,
  embed: string | null,
  source: string
): string {
  const lines: string[] = [];
  if (embed) lines.push(`![[${embed}]]`);
  if (plan.linkSource) lines.push(`[${source}](${source})`);
  if (lines.length === 0) return body;

  const trimmed = body.replace(/\s+$/, "");
  const lead = trimmed ? `${trimmed}\n\n` : "";
  return `${lead}${lines.join("\n\n")}\n`;
}
