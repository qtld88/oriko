import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type { ArchiveService } from "./archive-service";
import { ConfirmRenameModal } from "./confirm";
import { isInFolder } from "./core/scan";
import { isPluginOwned, liveRefs } from "./core/media-refs";
import { derivedRenames, planRenames, relink } from "./core/rename-media";
import type { NoteMedia, Rename } from "./core/rename-media";
import type { ClippingRecord } from "./core/scan";
import type { OrikoSettings } from "./core/settings";
import type { ClippingIndex } from "./index-store";

/**
 * Renames the media of a folder's clippings after their notes, the name a
 * fresh clip now gets. The Obsidian half of rename-media.ts: it works out
 * which files each note uses, asks, then moves them and rewrites links.
 */
export class RenameService {
  private running = false;

  constructor(
    private app: App,
    private settings: () => OrikoSettings,
    private archiver: ArchiveService,
    private index: ClippingIndex
  ) {}

  /** A reference as a note writes it, resolved to a file in the vault. */
  private resolve(link: string, from: string): string | null {
    const exact = this.app.vault.getFileByPath(normalizePath(link));
    if (exact) return exact.path;
    let decoded = link;
    try {
      decoded = decodeURIComponent(link);
    } catch {
      // Kept as written.
    }
    return this.app.metadataCache.getFirstLinkpathDest(decoded, from)?.path ?? null;
  }

  /** The originals a clipping uses: archived copies, its cover and its embeds. */
  private mediaOf(record: ClippingRecord): string[] {
    const cache = this.archiver.cache;
    const refs = liveRefs([record], cache.entries());
    const files = new Set<string>();
    for (const key of refs.keys) {
      const file = cache.get(key)?.file;
      if (file && this.app.vault.getFileByPath(file)) files.add(file);
    }
    for (const link of refs.paths) {
      const file = this.resolve(link, record.path);
      if (file) files.add(file);
    }
    return [...files];
  }

  /** What renaming the folder would do, without doing it. */
  plan(folder: TFolder): Rename[] {
    const records = this.index.records();
    const users = new Map<string, number>();
    const notes: NoteMedia[] = [];

    for (const record of records) {
      const files = this.mediaOf(record);
      for (const file of files) users.set(file, (users.get(file) ?? 0) + 1);
      if (folder.isRoot() || isInFolder(record.path, folder.path)) {
        notes.push({ path: record.path, files });
      }
    }

    const attachments = normalizePath(this.settings().attachmentFolder);
    const owned = (file: string): boolean =>
      Boolean(this.archiver.cache.byFile(file)) ||
      (isInFolder(file, attachments) && isPluginOwned(file.slice(file.lastIndexOf("/") + 1)));

    return planRenames(
      notes,
      (file) => (users.get(file) ?? 0) > 1,
      owned,
      (path) => Boolean(this.app.vault.getAbstractFileByPath(normalizePath(path)))
    );
  }

  /** Asks, then renames. Says so when there is nothing to do. */
  renameFolder(folder: TFolder): void {
    if (this.running) {
      new Notice("Oriko: already renaming media");
      return;
    }
    const renames = this.plan(folder);
    if (renames.length === 0) {
      new Notice("Oriko: every media file there is already named after its note");
      return;
    }
    new ConfirmRenameModal(this.app, renames, () => void this.apply(renames)).open();
  }

  private async apply(renames: Rename[]): Promise<void> {
    this.running = true;
    let renamed = 0;
    const failed: string[] = [];
    const cache = this.archiver.cache;

    try {
      for (const rename of renames) {
        const file = this.app.vault.getFileByPath(rename.from);
        if (!file) continue;
        try {
          // Obsidian rewrites links to it wherever the user lets it.
          await this.app.fileManager.renameFile(file, rename.to);

          const moved = new Map<string, string>([[rename.from, rename.to]]);
          for (const still of derivedRenames(rename.from, rename.to)) {
            const derived = this.app.vault.getFileByPath(still.from);
            if (!derived || this.app.vault.getAbstractFileByPath(still.to)) continue;
            await this.app.fileManager.renameFile(derived, still.to);
            moved.set(still.from, still.to);
          }

          for (const entry of cache.entries()) {
            const file = moved.get(entry.file);
            const thumb = moved.get(entry.thumb);
            if (file || thumb) {
              cache.set({ ...entry, file: file ?? entry.file, thumb: thumb ?? entry.thumb });
            }
          }

          // Whatever the link update left alone: the cover property, and
          // every link when the user has automatic updates off.
          const note = this.app.vault.getFileByPath(rename.note);
          if (note instanceof TFile) {
            await this.app.vault.process(note, (content) => relink(content, rename.from, rename.to));
            await this.index.handleModify(note);
          }
          renamed++;
        } catch (error) {
          failed.push(`${rename.from} (${String(error)})`);
        }
      }
    } finally {
      await this.archiver.saveCache();
      this.archiver.notifyChanged();
      this.running = false;
    }

    new Notice(
      `Oriko: renamed ${renamed} media file${renamed === 1 ? "" : "s"}` +
        (failed.length ? `, ${failed.length} failed` : ""),
      10000
    );
    for (const failure of failed) console.warn(`Oriko: could not rename ${failure}`);
  }
}
