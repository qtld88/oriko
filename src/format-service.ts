import { App, Notice, TFile, TFolder, normalizePath, parseYaml } from "obsidian";
import type { ArchiveService } from "./archive-service";
import { appendedBody, isEmptyPlan, planConformance } from "./core/conform";
import type { ConformPlan } from "./core/conform";
import type { HistoryEntry } from "./core/history";
import type { ProgressState } from "./core/progress";
import { clippingPathFor } from "./core/resolve";
import { splitFrontmatter } from "./core/scan";
import type { OrikoSettings } from "./core/settings";
import { fileableGrid } from "./core/spaces";
import { isInFolder } from "./index-store";
import type { ClippingIndex } from "./index-store";

/** One note as it was before a run and as the run left it, for undo. */
interface Change {
  from: string;
  to: string;
  before: string;
  after: string;
}

export interface FormatSummary {
  formatted: number;
  moved: number;
  pictures: number;
  fine: number;
  skipped: string[];
}

/**
 * Formats every note in a folder into a clipping: fills in the frontmatter
 * a clip would have had, finds it a picture, and files it where a clip
 * would have landed. See core/conform.ts for what counts as missing.
 *
 * The one place the plugin edits a note body it did not just write, and it
 * only ever appends.
 */
export class FormatService {
  onProgress: ((state: ProgressState | null) => void) | null = null;
  private running = false;

  constructor(
    private app: App,
    private settings: () => OrikoSettings,
    private archiver: ArchiveService,
    private index: ClippingIndex
  ) {}

  /** Every note the run would look at: markdown, at any depth, minus `_` files. */
  private notesIn(folder: TFolder): TFile[] {
    const out: TFile[] = [];
    const walk = (dir: TFolder): void => {
      for (const child of dir.children) {
        if (child instanceof TFolder) walk(child);
        else if (child instanceof TFile && child.extension === "md" && !child.name.startsWith("_")) {
          out.push(child);
        }
      }
    };
    walk(folder);
    return out;
  }

  /**
   * Runs over the folder and returns what it did, plus an undo entry when
   * anything changed.
   */
  async formatFolder(
    folder: TFolder
  ): Promise<{ summary: FormatSummary; undo: HistoryEntry | null } | null> {
    if (this.running) {
      new Notice("Oriko: already formatting");
      return null;
    }
    this.running = true;
    const summary: FormatSummary = { formatted: 0, moved: 0, pictures: 0, fine: 0, skipped: [] };
    const changes: Change[] = [];
    try {
      const notes = this.notesIn(folder);
      for (const [index, file] of notes.entries()) {
        this.onProgress?.({
          fraction: index / Math.max(1, notes.length),
          label: `Formatting ${index + 1}/${notes.length}…`,
        });
        try {
          const change = await this.formatNote(file, summary);
          if (change) changes.push(change);
        } catch (error) {
          summary.skipped.push(`${file.basename} (${String(error)})`);
        }
      }
      await this.archiver.deriveAssets();
      await this.archiver.saveCache();
    } finally {
      this.running = false;
      this.onProgress?.(null);
    }

    const undo: HistoryEntry | null =
      changes.length === 0
        ? null
        : {
            label: `Format ${changes.length} note${changes.length === 1 ? "" : "s"}`,
            undo: () => this.restore(changes, "before"),
            redo: () => this.restore(changes, "after"),
          };
    return { summary, undo };
  }

  private async formatNote(file: TFile, summary: FormatSummary): Promise<Change | null> {
    const before = await this.app.vault.read(file);
    const { yaml, rest } = splitFrontmatter(before);
    let frontmatter: Record<string, unknown> = {};
    if (yaml) {
      const parsed: unknown = parseYaml(yaml);
      if (parsed && typeof parsed === "object") frontmatter = parsed as Record<string, unknown>;
    }

    const conformance = planConformance(file.path, frontmatter, rest, file.stat.ctime);
    if (conformance.kind === "skip") {
      summary.skipped.push(`${file.basename} (${conformance.reason})`);
      return null;
    }
    const plan = conformance.plan;
    const settings = this.settings();
    const clippings = normalizePath(settings.clippingsFolder);
    const moving = !isInFolder(file.path, clippings);
    // Filed like a clip: onto the grid a clip made now would carry. Only a
    // note coming in gets one; a note already on the wall stays where it is.
    const grid =
      moving && typeof frontmatter.grid !== "string"
        ? fileableGrid(settings.activeGrid, settings.homeGridName, settings.grids)
        : "";

    if (isEmptyPlan(plan) && !moving) {
      summary.fine++;
      return null;
    }

    const title =
      typeof frontmatter.title === "string" && frontmatter.title.trim()
        ? frontmatter.title
        : file.basename;
    const source = typeof frontmatter.source === "string" ? frontmatter.source.trim() : "";
    const found = await this.findPicture(file, plan, source, title);
    const picture = found?.path ?? null;
    if (picture) summary.pictures++;

    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(plan.add)) {
        if (fm[key] === undefined) fm[key] = value;
      }
      if (plan.tags) fm.tags = plan.tags;
      if (picture) fm.cover = picture;
      if (grid) fm.grid = grid;
    });
    await this.app.vault.process(file, (content) => {
      const split = splitFrontmatter(content);
      const head = content.slice(0, content.length - split.rest.length);
      return head + appendedBody(split.rest, plan, found?.fromPage ? picture : null, source);
    });

    const from = file.path;
    if (moving) {
      if (!this.app.vault.getFolderByPath(clippings)) {
        await this.app.vault.createFolder(clippings).catch(() => {});
      }
      const target = normalizePath(
        clippingPathFor(clippings, title, source, (p) =>
          Boolean(this.app.vault.getAbstractFileByPath(normalizePath(p)))
        )
      );
      await this.app.fileManager.renameFile(file, target);
      summary.moved++;
    }
    summary.formatted++;
    // Capture does the same: the vault's own events only reach the index
    // for notes it already holds, and this one may be new to it.
    await this.index.handleModify(file);

    return { from, to: file.path, before, after: await this.app.vault.read(file) };
  }

  /**
   * The note's picture as a vault path, or null when it needs none or none
   * could be found. A body image already in the vault is used where it is.
   * A body image that cannot be had, a dead link or an embed of a file that
   * is gone, falls back to the page's own picture, as a note with no image
   * does. `fromPage` says the picture is not in the body yet.
   */
  private async findPicture(
    file: TFile,
    plan: ConformPlan,
    source: string,
    title: string
  ): Promise<{ path: string; fromPage: boolean } | null> {
    const picture = plan.picture;
    if (picture.kind === "none") return null;
    if (picture.kind === "body") {
      const path = picture.remote
        ? await this.archiver.archivePicture(picture.url, source, title)
        : this.app.metadataCache.getFirstLinkpathDest(picture.url, file.path)?.path ?? null;
      if (path) return { path, fromPage: false };
      if (!/^https?:\/\//i.test(source)) return null;
    }
    const path = await this.archiver.archivePagePicture(source, title);
    return path ? { path, fromPage: true } : null;
  }

  /** Puts every changed note back to one side of the run: its path and its content. */
  private async restore(changes: Change[], side: "before" | "after"): Promise<void> {
    const clippings = normalizePath(this.settings().clippingsFolder);
    for (const change of changes) {
      const [here, there] = side === "before" ? [change.to, change.from] : [change.from, change.to];
      const file = this.app.vault.getFileByPath(here);
      if (!file) continue;
      await this.app.vault.modify(file, side === "before" ? change.before : change.after);
      if (here !== there && !this.app.vault.getAbstractFileByPath(there)) {
        await this.app.fileManager.renameFile(file, there);
      }
      if (isInFolder(file.path, clippings)) await this.index.handleModify(file);
      else this.index.handleDelete(here);
    }
  }
}

/** One line for the notice at the end of a run. */
export function describeSummary(summary: FormatSummary): string {
  const parts = [`formatted ${summary.formatted}`];
  if (summary.moved) parts.push(`moved ${summary.moved} to clippings`);
  if (summary.pictures) parts.push(`found ${summary.pictures} picture${summary.pictures === 1 ? "" : "s"}`);
  if (summary.fine) parts.push(`${summary.fine} already fine`);
  const skipped = summary.skipped.length;
  let line = `Oriko: ${parts.join(", ")}`;
  if (skipped) {
    const names = skipped <= 3 ? `: ${summary.skipped.join("; ")}` : "";
    line += `. Skipped ${skipped}${names}`;
  }
  return line;
}
