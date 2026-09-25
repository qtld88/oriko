import { Notice, normalizePath } from "obsidian";
import type { App, TFile } from "obsidian";
import type { Classifier } from "./classifier";
import { NO_VERDICT, hasEngine, usableCategories } from "./core/classify";
import type { Classification } from "./core/classify";
import type { OrikoSettings } from "./core/settings";
import {
  AttemptLog,
  applySortPatch,
  emptyCounts,
  handSorted,
  noteResult,
  noteState,
  pickCandidates,
  sortPatch,
  sweepSummary,
  UNSORTED_KEY,
} from "./core/unsorted";
import type { NoteResult, SortPatch, SweepCounts } from "./core/unsorted";

/**
 * Sorting what capture could not: the notes marked `unsorted: true`, on
 * whichever device has an engine. The decisions are in ./core/unsorted.ts;
 * this file reads the cache, writes the frontmatter and moves the files.
 * Like ./classifier.ts it is not unit-tested.
 */

/** A sync writes a note in pieces. This long without a new one means it is done. */
const QUIET_MS = 5000;
/** A slow chat model must not serialise a run of forty notes. */
const PARALLEL = 3;

/** A note a person already sorted: the marker goes, nothing is asked. */
const HAND_SORTED: Classification = { verdict: NO_VERDICT, outcome: "sorted" };

function plural(count: number): string {
  return count === 1 ? "clipping" : "clippings";
}

export class SortService {
  /** Shared with capture, which registers every note it writes. */
  readonly attempts = new AttemptLog();
  private running = false;
  private pending = new Set<string>();
  private timer = 0;
  /** Each watcher warning once a session, not once per arrival. By text, so
      one kind of failure does not silence another. */
  private warned = new Set<string>();
  /**
   * Renames, one at a time. Finding a free name and taking it are two steps
   * with an await between them, and three workers filing two "Lamp.md" into
   * the same category would otherwise both pick the same one.
   */
  private moves: Promise<void> = Promise.resolve();

  constructor(
    private app: App,
    private settings: () => OrikoSettings,
    private classifier: Classifier
  ) {}

  /** Clears the debounce, for unload. */
  stop(): void {
    window.clearTimeout(this.timer);
  }

  /** Every marked note, by path. Also the palette row's count. */
  candidates(): string[] {
    const entries = this.app.vault.getMarkdownFiles().map((file) => ({
      path: file.path,
      frontmatter: this.app.metadataCache.getFileCache(file)?.frontmatter,
    }));
    return pickCandidates(entries, this.settings().clippingsFolder);
  }

  /** The command. Every marked note, including the ones that failed before. */
  async sortAll(): Promise<void> {
    if (this.running) {
      new Notice("Oriko: already sorting");
      return;
    }
    const blocker = this.blocker();
    if (blocker) {
      new Notice(blocker);
      return;
    }
    const paths = this.candidates();
    if (paths.length === 0) {
      new Notice("Oriko: no unsorted clippings");
      return;
    }
    new Notice(`Oriko: sorting ${paths.length} ${plural(paths.length)}…`);
    const counts = await this.run(paths);
    new Notice(`Oriko: ${sweepSummary(counts, this.settings().sortFallback.trim())}`);
  }

  /** At layout-ready, and when sortArrivals is turned on. */
  drainAll(): void {
    for (const path of this.candidates()) this.pending.add(path);
    this.schedule();
  }

  /**
   * Called for every metadataCache "changed", which fires once the
   * frontmatter is parsed, so after a sync has finished writing the file.
   */
  noticeChange(file: TFile, frontmatter: Record<string, unknown> | undefined): void {
    if (!this.settings().sortArrivals) return;
    const marked = pickCandidates([{ path: file.path, frontmatter }], this.settings().clippingsFolder);
    if (marked.length === 0) return;
    this.pending.add(file.path);
    this.schedule();
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.drainPending(), QUIET_MS);
  }

  private async drainPending(): Promise<void> {
    if (!this.settings().sortArrivals) {
      this.pending.clear();
      return;
    }
    if (this.running) {
      this.schedule();
      return;
    }
    const paths = [...this.pending].filter((path) => this.isDue(path));
    this.pending.clear();
    if (paths.length === 0) return;

    const blocker = this.blocker();
    if (blocker) {
      this.warnOnce(blocker);
      return;
    }
    const counts = await this.run(paths);
    const sorted = counts.sorted + counts.fallback;
    if (sorted > 0) {
      new Notice(`Oriko: ${sorted} ${plural(sorted)} sorted from another device`);
    } else if (counts.unreachable > 0) {
      this.warnOnce("Oriko: no sorting engine answered, so new clippings stay unsorted");
    }
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    new Notice(message);
  }

  /** Skips a note the last attempt already saw in this exact state. */
  private isDue(path: string): boolean {
    const file = this.app.vault.getFileByPath(path);
    return file !== null && this.attempts.due(path, file.stat.mtime);
  }

  /** Why nothing can be sorted on this device, or null. Checked once per run. */
  private blocker(): string | null {
    const s = this.settings();
    if (usableCategories(s.sortCategories).length === 0) {
      return "Oriko: nothing to sort into. Declare categories in Settings → Oriko → Categories.";
    }
    if (!hasEngine(s)) {
      return "Oriko: no sorting engine on this device. Set an endpoint in Settings → Oriko, or sort from a device that has one.";
    }
    return null;
  }

  private async run(paths: string[]): Promise<SweepCounts> {
    this.running = true;
    const counts = emptyCounts();
    const queue = [...paths];
    const worker = async (): Promise<void> => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const result = await this.sortOne(path);
        if (result) counts[result]++;
      }
    };
    try {
      await Promise.all(Array.from({ length: PARALLEL }, worker));
    } finally {
      this.running = false;
    }
    return counts;
  }

  /** One note. Null for a note that is no longer there to sort. */
  private async sortOne(path: string): Promise<NoteResult | null> {
    const file = this.app.vault.getFileByPath(path);
    // Deleted or moved since the run began.
    if (!file) return null;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    // Sorted since the run began: by a person, or by another device's sweep
    // arriving through sync.
    if (frontmatter?.unsorted !== true) return null;
    this.attempts.record(path, file.stat.mtime);

    const classification = handSorted(frontmatter)
      ? HAND_SORTED
      : await this.classifier
          .classify(noteState(frontmatter), { ignoreSwitch: true })
          .catch((): Classification => ({ verdict: NO_VERDICT, outcome: "unavailable" }));
    const result = noteResult(classification.outcome);
    // Settings changed under a running sweep. blocker() said yes a moment ago.
    if (result === "stop") return null;
    if (result !== "sorted" && result !== "fallback") return result;

    const destination = this.settings().sortDestination;
    if (!sortPatch(frontmatter, classification.verdict, destination)) return "unsure";
    // Rebuilt from the frontmatter as it is now, not as it was before the
    // engine was asked. A chat model can take thirty seconds, and a person who
    // typed a category in the meantime has sorted the note by hand: their
    // category stays, only the marker goes.
    const written: { patch: SortPatch | null } = { patch: null };
    try {
      await this.app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
        if (front[UNSORTED_KEY] !== true) return;
        written.patch = sortPatch(front, classification.verdict, destination);
        if (written.patch) applySortPatch(front, written.patch);
      });
    } catch {
      return "failed";
    }
    const patch = written.patch;
    // The marker went while the engine was thinking: someone else sorted it.
    if (!patch) return null;
    // The frontmatter write is the commit point. A move that fails leaves a
    // sorted note where it was: untidy, not wrong.
    if (patch.subfolder) {
      const moved = this.moves.then(() => this.move(file, patch.subfolder));
      this.moves = moved.catch(() => {});
      await this.moves;
    }
    return result;
  }

  /**
   * Safe for notes Oriko wrote: media are embedded from the vault root and
   * `cover:` is stored the same way, so nothing in the note is relative to
   * where it lives. The same " 2" suffix on a collision as createNote.
   */
  private async move(file: TFile, subfolder: string): Promise<void> {
    const folder = normalizePath(`${this.settings().clippingsFolder}/${subfolder}`);
    if (file.parent?.path === folder) return;
    if (!this.app.vault.getFolderByPath(folder)) {
      await this.app.vault.createFolder(folder).catch(() => {});
    }
    let target = normalizePath(`${folder}/${file.basename}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(target)) {
      target = normalizePath(`${folder}/${file.basename} ${n}.md`);
      n++;
    }
    await this.app.fileManager.renameFile(file, target);
  }
}
