import { clippingState, destinationFields, verdictSubfolder } from "./classify";
import type { SortDestination, SortOutcome, Verdict } from "./classify";
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

/** A frontmatter edit, computed here and applied inside processFrontMatter. */
export interface SortPatch {
  /** Keys deleted: always the marker. */
  remove: string[];
  /** Keys set outright. */
  set: Record<string, unknown>;
  /** Added to `tags`, keeping what is already there. */
  tags: string[];
  /** The subfolder of the clippings folder to move the note into, or "". */
  subfolder: string;
}

/** A note with a category a person set. The marker is stale; nothing else is. */
export function handSorted(frontmatter: Record<string, unknown>): boolean {
  const value = frontmatter.categories;
  if (Array.isArray(value)) return value.some((item) => typeof item === "string" && item.trim() !== "");
  return typeof value === "string" && value.trim() !== "";
}

function isSet(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * What the sweep writes, or null to leave the note exactly as it is.
 *
 * A grid or folder the note already carries is kept. Capture does the same:
 * buildNote writes the explicit grid after the sorting lines, so a clip shared
 * into a named grid stays there whatever the destination says.
 */
export function sortPatch(
  frontmatter: Record<string, unknown>,
  verdict: Verdict,
  destination: SortDestination
): SortPatch | null {
  if (handSorted(frontmatter)) return { remove: [UNSORTED_KEY], set: {}, tags: [], subfolder: "" };
  if (!verdict.category) return null;

  const fields = destinationFields(verdict, destination);
  const set: Record<string, unknown> = { categories: fields.categories };
  if (fields.grid !== undefined && !isSet(frontmatter.grid)) set.grid = fields.grid;
  if (fields.folder !== undefined && !isSet(frontmatter.folder)) set.folder = fields.folder;
  return {
    remove: [UNSORTED_KEY],
    set,
    tags: verdict.tags,
    subfolder: verdictSubfolder(verdict, destination),
  };
}

function tagList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === "string");
  return typeof value === "string" && value !== "" ? [value] : [];
}

/** Applies a patch to the object processFrontMatter hands over, in place. */
export function applySortPatch(frontmatter: Record<string, unknown>, patch: SortPatch): void {
  for (const key of patch.remove) delete frontmatter[key];
  Object.assign(frontmatter, patch.set);
  if (patch.tags.length === 0) return;
  const tags = tagList(frontmatter.tags);
  for (const tag of patch.tags) if (!tags.includes(tag)) tags.push(tag);
  frontmatter.tags = tags;
}

/**
 * The last attempt on each note, by modification time. Held in memory: a note
 * the engine was unsure of is not asked again until it changes, which a
 * person's edit does, and a restart is a fair moment to try everything again.
 */
export class AttemptLog {
  private attempts = new Map<string, number>();

  record(path: string, mtime: number): void {
    this.attempts.set(path, mtime);
  }

  /** False while the note is unchanged since it was last tried. */
  due(path: string, mtime: number): boolean {
    return this.attempts.get(path) !== mtime;
  }
}

/** What happened to one note in a sweep. */
export type NoteResult = "sorted" | "fallback" | "unsure" | "unreachable" | "noText" | "failed";

export type SweepCounts = Record<NoteResult, number>;

export function emptyCounts(): SweepCounts {
  return { sorted: 0, fallback: 0, unsure: 0, unreachable: 0, noText: 0, failed: 0 };
}

/**
 * One note's outcome as the summary counts it. "stop" is an outcome that is
 * about the device, not the note: every other note would get the same answer.
 */
export function noteResult(outcome: SortOutcome): NoteResult | "stop" {
  switch (outcome) {
    case "sorted":
    case "fallback":
    case "unsure":
      return outcome;
    case "unavailable":
      return "unreachable";
    case "no-text":
      return "noText";
    default:
      return "stop";
  }
}

/** The run in one line: "31 sorted · 3 filed under MISC · 4 unsure · 2 unreachable". */
export function sweepSummary(counts: SweepCounts, fallback: string): string {
  const parts: string[] = [];
  if (counts.sorted) parts.push(`${counts.sorted} sorted`);
  if (counts.fallback) parts.push(`${counts.fallback} filed under ${fallback}`);
  if (counts.unsure) parts.push(`${counts.unsure} unsure`);
  if (counts.unreachable) parts.push(`${counts.unreachable} unreachable`);
  if (counts.noText) parts.push(`${counts.noText} with no text`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  return parts.length > 0 ? parts.join(" · ") : "nothing sorted";
}
