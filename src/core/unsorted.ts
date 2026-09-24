import { clippingState } from "./classify";
import { isInFolder } from "./scan";

/**
 * The queue of clippings no engine decided, and how the sweep drains it.
 *
 * `unsorted: true` is the queue: capture writes it whenever no engine
 * decided, whatever the reason, and the sweep in ../sort-service.ts removes it
 * once one has. Nothing else is read or recorded to find the pile.
 * Design: docs/superpowers/specs/2026-09-24-deferred-sorting-design.md.
 */

/** The marker capture writes and the sweep removes. */
export const UNSORTED_KEY = "unsorted";

/** A note as the metadata cache describes it. */
export interface NoteEntry {
  path: string;
  /** Undefined for a note with no frontmatter, or one the cache has not read yet. */
  frontmatter: Record<string, unknown> | undefined;
}

/**
 * The marked notes, by path. The boolean only: a string "true" is a person
 * typing, not a clip Oriko queued, and the sweep does not guess.
 */
export function pickCandidates(entries: readonly NoteEntry[], folder: string): string[] {
  return entries
    .filter((entry) => isInFolder(entry.path, folder) && entry.frontmatter?.[UNSORTED_KEY] === true)
    .map((entry) => entry.path);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** What the model reads, built from the note the same way capture built it. */
export function noteState(frontmatter: Record<string, unknown>): string {
  return clippingState(text(frontmatter.title), text(frontmatter.description), text(frontmatter.source));
}
