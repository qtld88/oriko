import { todayISO } from "./dates";
import { scanClipping } from "./scan";

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
  /** The first image in the body, remote or a vault embed. */
  | { kind: "body"; url: string; remote: boolean }
  /** Nothing in the body: the source page's own preview image. */
  | { kind: "page"; source: string };

export interface ConformPlan {
  /** Keys to add to the frontmatter, with the value each is given. */
  add: Record<string, unknown>;
  /** `tags` as it should read, or null when it already carries clippings. */
  tags: string[] | null;
  picture: PictureSource;
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

function hasClippingTag(tags: string[]): boolean {
  return tags.some((tag) => tag.replace(/^#/, "").toLowerCase() === CLIPPING_TAG);
}

/**
 * What a note needs to become a clipping.
 *
 * @param created the file's creation time, stamped when the note has no
 * `created` of its own.
 */
export function planConformance(
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
  created: number
): Conformance {
  const record = scanClipping(path, frontmatter, body);
  const source = typeof frontmatter.source === "string" ? frontmatter.source.trim() : "";
  const remoteSource = /^https?:\/\//i.test(source);

  let picture: PictureSource = { kind: "none" };
  if (!record.cover) {
    const first = record.media[0];
    if (first?.kind === "image") {
      picture = { kind: "body", url: first.url, remote: /^https?:\/\//i.test(first.url) };
    } else if (!first) {
      picture = remoteSource ? { kind: "page", source } : picture;
    }
  }

  // Nothing to show and nowhere to look for it: a wall tile needs a
  // picture, so a note like this would join the clippings and show nowhere.
  if (!record.cover && record.media.length === 0 && !remoteSource) {
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

  return { kind: "plan", plan: { add, tags, picture, linkSource } };
}

/** True when the plan changes nothing about the note itself. */
export function isEmptyPlan(plan: ConformPlan): boolean {
  return (
    Object.keys(plan.add).length === 0 &&
    plan.tags === null &&
    plan.picture.kind === "none" &&
    !plan.linkSource
  );
}

/**
 * Lines to append to the body. Existing text is never edited: the picture is
 * embedded only when it came from the page, since a body image is already
 * in the body, and the source is linked only when the body does not already
 * name it.
 */
export function appendedBody(
  body: string,
  plan: ConformPlan,
  picturePath: string | null,
  source: string
): string {
  const lines: string[] = [];
  if (plan.picture.kind === "page" && picturePath) lines.push(`![[${picturePath}]]`);
  if (plan.linkSource) lines.push(`[${source}](${source})`);
  if (lines.length === 0) return body;

  const trimmed = body.replace(/\s+$/, "");
  const lead = trimmed ? `${trimmed}\n\n` : "";
  return `${lead}${lines.join("\n\n")}\n`;
}
