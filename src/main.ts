import {
  Notice,
  ObsidianProtocolData,
  Platform,
  Plugin,
  addIcon,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  parseYaml,
} from "obsidian";
import type { CachedMetadata } from "obsidian";
import { buildDiagnostics } from "./core/diagnose";
import { setToolOverrides } from "./convert";
import { ArchiveService } from "./archive-service";
import { CaptureService } from "./capture";
import { FolderPickerModal } from "./folder-picker";
import { FormatService, describeSummary } from "./format-service";
import { RenameService } from "./rename-service";
import { ClippingIndex } from "./index-store";
import { OrikoSettings, DEFAULT_SETTINGS } from "./core/settings";
import { isStage } from "./core/density";
import {
  LEGACY_SHARED_FILES,
  SHARED_FILE,
  extractShared,
  hasSortKeys,
  isDefaultShared,
  isDefaultSort,
  parseShared,
  publishesSort,
  serializeShared,
  sharedOf,
  withShared,
} from "./core/shared-config";
import { describeFiles } from "./core/media-refs";
import { installRepair } from "./repair";
import { Classifier } from "./classifier";
import { SortService } from "./sort-service";
import { sharedHttpUrl } from "./core/resolve";
import { sharedClipGrid } from "./core/spaces";
import { ORIKO_ICON_ID, ORIKO_ICON_SVG } from "./core/icon";
import { ConfirmSweepModal } from "./confirm";
import { findOrphans, removeMedia, staleKeys } from "./sweep";
import { OrikoSettingTab } from "./settings-tab";
import { OrikoView, VIEW_TYPE_GRID } from "./view";

export default class OrikoPlugin extends Plugin {
  settings: OrikoSettings = DEFAULT_SETTINGS;
  index!: ClippingIndex;
  archiver!: ArchiveService;
  capture!: CaptureService;
  sorter!: SortService;
  format!: FormatService;
  renamer!: RenameService;
  /** The last shared file this device wrote, to recognise its own echo. */
  private wroteShared = "";
  /**
   * Whether the shared file, as this device last read or wrote it, carried the
   * sort keys. Until it does, a device holding default sort values leaves them
   * out, so it cannot publish an empty category list over the desktop's.
   */
  private sharedHasSort = false;
  private archiveTimer = 0;

  /**
   * Schedules the background archive pass, debounced: a sync storm of
   * created files coalesces into one pass instead of stacking timers, and
   * the pending timer is cleared on unload so nothing fires afterwards.
   */
  private scheduleArchive(delayMs: number): void {
    window.clearTimeout(this.archiveTimer);
    this.archiveTimer = window.setTimeout(() => void this.archiver.archiveMissing(), delayMs);
  }

  async onload(): Promise<void> {
    addIcon(ORIKO_ICON_ID, ORIKO_ICON_SVG);
    this.register(() => window.clearTimeout(this.archiveTimer));
    await this.loadSettings();
    // After the settings, because it needs the clippings folder to know where
    // to look, and before anything reads a grid.
    await this.syncShared();
    this.watchShared();

    this.index = new ClippingIndex(
      this.app,
      () => this.settings.clippingsFolder,
      parseYaml
    );
    this.archiver = new ArchiveService(
      this.app,
      this.index,
      () => this.settings,
      this.manifest.dir ?? `${this.app.vault.configDir}/plugins/oriko`
    );
    await this.archiver.loadCache();
    const classifier = new Classifier(() => this.settings);
    this.sorter = new SortService(this.app, () => this.settings, classifier);
    this.register(() => this.sorter.stop());
    this.capture = new CaptureService(
      this.app,
      () => this.settings,
      this.archiver,
      this.index,
      classifier,
      this.sorter.attempts
    );
    this.format = new FormatService(
      this.app,
      () => this.settings,
      this.archiver,
      this.index
    );
    this.renamer = new RenameService(
      this.app,
      () => this.settings,
      this.archiver,
      this.index
    );

    this.registerView(
      VIEW_TYPE_GRID,
      (leaf: WorkspaceLeaf) => new OrikoView(leaf, this)
    );

    // obsidian://oriko?url=… — the share-sheet route in. An iOS Shortcut
    // hands the shared link straight here, so clipping from another app
    // never touches the clipboard. Prose around the link is tolerated
    // because share sheets send captions, not bare URLs.
    const handleClipUri = (params: ObsidianProtocolData): void => {
      const raw = params.url ?? params.text ?? "";
      const url = sharedHttpUrl(raw);
      if (!url) {
        // The received text is shown so a broken Shortcut diagnoses itself:
        // empty means nothing arrived, %3A soup means over-encoding.
        new Notice(
          raw
            ? `Oriko: no link in the shared text (got "${raw.slice(0, 80)}")`
            : "Oriko: the share arrived empty"
        );
        return;
      }
      const s = this.settings;
      const grid = sharedClipGrid(s.sharedClipTarget, s.activeGrid, s.homeGridName, s.grids);
      // A share that already knows its grid never needs the wall. On a phone
      // the clip is the whole point, and opening the view takes over the
      // screen you shared from; the note lands either way, and a notice says
      // so. Only "ask" has a question to put on screen.
      if (grid !== null) {
        void this.capture.capture(url, grid, true);
        return;
      }
      // The view first, so the capture's progress bar has a wall to sit on
      // and the clipped tile has somewhere to fly in.
      void this.activateView().then((view) => {
        if (!view) return this.capture.capture(url, undefined, true);
        view.pickGridAndClip(url);
      });
    };
    this.registerObsidianProtocolHandler("oriko", handleClipUri);

    this.addSettingTab(new OrikoSettingTab(this.app, this));
    installRepair(this);

    this.addRibbonIcon(ORIKO_ICON_ID, "Open Oriko", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open",
      name: "Open the wall",
      callback: () => void this.activateView(),
    });

    // Registered as a command rather than left to the view's own key
    // listener: ⌘K is a core default (Insert Markdown link), so Obsidian's
    // dispatcher claims the chord before a DOM listener ever sees it. Going
    // through the command system is what puts the wall's search on the key,
    // and it makes the binding reassignable in Settings → Hotkeys like
    // everything else.
    this.addCommand({
      id: "open-search",
      name: "Search this grid",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(OrikoView);
        if (!view) return false;
        if (!checking) view.togglePalette();
        return true;
      },
    });

    // One command for whatever is on the clipboard, as paste is: a picture
    // or a video is saved as itself, text is taken as a link. Scoped to the
    // wall like the search, since ⌘N is new note everywhere else.
    this.addCommand({
      id: "clip-from-clipboard",
      name: "Clip from clipboard",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(OrikoView);
        if (!view) return false;
        if (!checking) void this.clipFromClipboard();
        return true;
      },
    });

    this.addCommand({
      id: "rescan-clippings",
      name: "Rescan clippings folder",
      callback: () => {
        void this.index.rebuild().then(() => {
          new Notice("Oriko: clippings rescanned");
        });
      },
    });

    this.addCommand({
      id: "sweep-orphan-media",
      name: "Remove orphaned media",
      callback: () => this.sweepOrphanMedia(),
    });

    // The wall's whole pipeline runs blind on mobile, where there is no
    // console to ask; this puts the paint's own arithmetic on the clipboard
    // so a phone can answer "why is this tile missing" by pasting.
    this.addCommand({
      id: "copy-diagnostics",
      name: "Copy grid diagnostics",
      callback: async () => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID)[0];
        const view = leaf?.view instanceof OrikoView ? leaf.view : null;
        const state = view?.diagnosticState();
        const report = buildDiagnostics({
          version: this.manifest.version,
          platform: Platform.isMobile ? "mobile" : "desktop",
          activeGrid: state?.grid ?? this.settings.activeGrid,
          home: this.settings.homeGridName,
          registered: this.settings.grids.map((grid) => grid.name),
          records: this.index.records(),
          cache: this.archiver.cache,
          unloadable: state?.unloadable ?? [],
          filtered: state?.filtered ?? false,
        });
        await navigator.clipboard.writeText(report);
        new Notice("Oriko: diagnostics copied to the clipboard");
      },
    });

    this.addCommand({
      id: "format-folder",
      name: "Format notes in a folder…",
      callback: () => new FolderPickerModal(this.app, (folder) => void this.formatFolder(folder)).open(),
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((item) =>
          item
            .setTitle("Format notes with Oriko")
            .setIcon(ORIKO_ICON_ID)
            .onClick(() => void this.formatFolder(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("Rename media after their notes")
            .setIcon(ORIKO_ICON_ID)
            .onClick(() => this.renamer.renameFolder(file))
        );
      })
    );

    this.addCommand({
      id: "rename-media",
      name: "Rename media after their notes in a folder…",
      callback: () =>
        new FolderPickerModal(this.app, (folder) => this.renamer.renameFolder(folder)).open(),
    });

    this.addCommand({
      id: "archive-clipping-media",
      name: "Download all clipping media",
      callback: () => this.archiveAllMedia(),
    });

    // Any device can run it; one with no engine says so and stops. It also
    // retries notes an engine was unsure of before, which the watcher does not.
    this.addCommand({
      id: "sort-unsorted",
      name: "Sort unsorted clippings",
      callback: () => void this.sorter.sortAll(),
    });

    this.app.workspace.onLayoutReady(() => {
      void this.index.rebuild().then(() => {
        // Archiving runs behind the grid, which is already showing remote
        // covers, and tiles swap to local files as they arrive.
        if (this.settings.archiveOnCreate) {
          this.scheduleArchive(1500);
        }
        // Obsidian stays open for days, so this alone would rarely fire. The
        // watcher below catches what arrives after.
        if (this.settings.sortArrivals) this.sorter.drainAll();
      });
    });

    // When the folder is not being watched, only files already on the wall
    // keep tracking their edits; a new arrival waits for a rescan or the
    // next launch. Explicit clips are unaffected: capture feeds the index
    // directly rather than through these events.
    const admits = (path: string): boolean =>
      this.settings.watchClippings || this.index.get(path) !== undefined;

    this.registerEvent(
      this.app.vault.on("create", (f: TAbstractFile) => {
        if (!(f instanceof TFile) || !admits(f.path)) return;
        void this.index.handleModify(f).then(() => {
          // The Web Clipper writes the body and frontmatter in stages, so
          // give it a moment before scanning for media to download.
          if (this.settings.archiveOnCreate) {
            this.scheduleArchive(2000);
          }
        });
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (f: TAbstractFile) => {
        if (f instanceof TFile && admits(f.path)) void this.index.handleModify(f);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (f: TAbstractFile) => this.index.handleDelete(f.path))
    );
    this.registerEvent(
      this.app.vault.on("rename", (f: TAbstractFile, oldPath: string) => {
        if (f instanceof TFile && admits(oldPath)) void this.index.handleRename(f, oldPath);
      })
    );

    // Frontmatter arrives through the metadata cache, which resolves after
    // the file write. Without this the first scan of a fresh clipping sees
    // no categories or status.
    this.registerEvent(
      this.app.metadataCache.on("changed", (f: TFile) => {
        if (admits(f.path)) void this.index.handleModify(f);
      })
    );

    // Not gated by `admits`: an unsorted clip from another device is exactly
    // the note that is not on the wall yet.
    this.registerEvent(
      this.app.metadataCache.on("changed", (f: TFile, _data: string, cache: CachedMetadata) =>
        this.sorter.noticeChange(f, cache.frontmatter)
      )
    );
  }

  /**
   * Offers up everything in the attachment folder that no clipping points
   * at any more: media left behind by deletions that predate reference
   * counting, and captures whose note was removed before it was written.
   *
   * Asks first, always, and moves to Obsidian's trash rather than deleting,
   * because the plugin is guessing about files it did not just create.
   */
  sweepOrphanMedia(): void {
    const orphans = findOrphans(
      this.app,
      this.index.records(),
      this.archiver.cache,
      this.settings.attachmentFolder
    );

    // Rows pointing at files that are already gone cost nothing to keep but
    // make the archiver skip a re-download it should do, so they go either
    // way, sweep or no sweep.
    const stale = staleKeys(this.app, this.archiver.cache);

    if (orphans.paths.length === 0) {
      if (stale.length > 0) {
        for (const key of stale) this.archiver.cache.delete(key);
        void this.archiver.saveCache();
      }
      new Notice("Oriko: no orphaned media to remove");
      return;
    }

    new ConfirmSweepModal(this.app, orphans, describeFiles(orphans), () => {
      void (async () => {
        const removed = await removeMedia(this.app, this.archiver.cache, orphans.paths);
        for (const key of stale) this.archiver.cache.delete(key);
        await this.archiver.saveCache();
        new Notice(
          `Oriko: ${removed} media file${removed === 1 ? "" : "s"} moved to trash`
        );
      })();
    }).open();
  }

  /**
   * Formats a folder of notes into clippings, then reports what it did. The
   * run goes into the wall's history, so ⌘Z there takes the whole run back.
   */
  async formatFolder(folder: TFolder): Promise<void> {
    new Notice(`Oriko: formatting ${folder.isRoot() ? "the vault" : folder.path}…`);
    const result = await this.format.formatFolder(folder);
    if (!result) return;
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID)[0];
    if (result.undo && leaf?.view instanceof OrikoView) leaf.view.recordHistory(result.undo);
    new Notice(describeSummary(result.summary), 10000);
  }

  /** Lifted out of its command so the grid's palette can call it too. */
  archiveAllMedia(): void {
    new Notice("Oriko: downloading media…");
    void this.archiver.archiveEverything().then((r) => this.archiver.notifyResult(r));
  }

  /** Lifted out of its command so the grid's create menu can call it too. */
  /**
   * Clips whatever the clipboard holds, deciding as the paste handler does:
   * a picture or a video is saved as itself, anything else is read as text
   * and taken as a link.
   */
  async clipFromClipboard(): Promise<void> {
    let items: ClipboardItems;
    try {
      items = await navigator.clipboard.read();
    } catch {
      new Notice("Oriko: could not read the clipboard");
      return;
    }
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/") || t.startsWith("video/"));
      if (!type) continue;
      await this.capture.captureMedia(await item.getType(type));
      return;
    }
    await this.capture.captureFromClipboard();
  }

  /** Opens the wall, or brings it forward, and hands back its view. */
  async activateView(): Promise<OrikoView | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID);
    let leaf = existing[0];
    if (leaf) {
      await this.app.workspace.revealLeaf(leaf);
    } else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_GRID, active: true });
    }
    return leaf.view instanceof OrikoView ? leaf.view : null;
  }

  /** Where the vault's half of the settings lives. */
  private sharedPath(): string {
    return normalizePath(`${this.settings.clippingsFolder}/${SHARED_FILE}`);
  }

  /** Where it lived before it was markdown. */
  /**
   * Reads the shared half out of the vault, and writes it there the first
   * time if it is missing.
   *
   * The write is the migration: a vault that predates this has its grids in
   * data.json and nowhere else, and the first device to open it publishes
   * them. Devices that already had none, a phone that only ever received the
   * plugin through BRAT, then read that file rather than starting empty.
   */
  private async syncShared(): Promise<void> {
    const path = this.sharedPath();
    // Adapter, not the Vault API, throughout this method and writeShared:
    // it runs at onload, before the vault index is populated on a cold
    // start, and getFileByPath answering null here once cost a device its
    // grids. The adapter reads the filesystem and is always ready.
    const adapter = this.app.vault.adapter;

    if (await adapter.exists(path)) {
      try {
        const body = await adapter.read(path);
        this.wroteShared = body;
        const raw = extractShared(body);
        if (raw !== null) {
          this.sharedHasSort = hasSortKeys(raw);
          this.settings = withShared(this.settings, parseShared(raw, sharedOf(this.settings)));
          // The upgrade: a file written before sorting was shared, read by
          // the device whose data.json still holds the categories. It
          // publishes them now rather than at its next save.
          if (!this.sharedHasSort && !isDefaultSort(sharedOf(this.settings))) {
            await this.writeShared();
          }
          return;
        }
      } catch {
        // Fall through to the notice below.
      }
      // Unreadable, or half-written by a sync still in flight. What this
      // device already has beats nothing, and the next save republishes it.
      new Notice("Oriko: could not read the shared grid configuration.");
      return;
    }

    // The names this file has carried before. Read once, so a vault that
    // already published one carries over instead of starting again, and
    // then retired: leaving both would be two files claiming to define the
    // same grids.
    for (const name of LEGACY_SHARED_FILES) {
      const legacy = normalizePath(`${this.settings.clippingsFolder}/${name}`);
      if (!(await adapter.exists(legacy))) continue;
      try {
        const raw = extractShared(await adapter.read(legacy));
        if (raw !== null) {
          this.settings = withShared(this.settings, parseShared(raw, sharedOf(this.settings)));
        }
      } catch {
        // Nothing to carry over; the write below publishes what we have.
      }
      await this.writeShared();
      // To the trash rather than deleted outright: it is the plugin's own
      // file, but it is in the user's vault.
      await adapter.trashLocal(legacy).catch(() => {});
      return;
    }

    // Whoever writes the file first wins it, so a device that has nothing but
    // the defaults does not get to. See isDefaultShared.
    if (!isDefaultShared(sharedOf(this.settings))) await this.writeShared();
  }

  private async writeShared(): Promise<void> {
    const shared = sharedOf(this.settings);
    const withSort = publishesSort(shared, this.sharedHasSort);
    const body = serializeShared(shared, withSort);
    // saveSettings also runs for the device's own half, the tile size among
    // them, and rewriting an identical file for those is sync churn on every
    // device rather than a change to anything.
    if (body === this.wroteShared) return;
    const path = this.sharedPath();
    const folder = this.settings.clippingsFolder;
    // Adapter for the same reason syncShared gives: this can run at onload,
    // when the vault index cannot yet answer for the folder or the file.
    // Checked before the body is remembered: a write that never happened must
    // not make the next save think the file already says this.
    if (folder && !(await this.app.vault.adapter.exists(normalizePath(folder)))) return;
    // Remembered so the modify event our own write raises can be told apart
    // from one that arrived by sync.
    this.wroteShared = body;
    await this.app.vault.adapter.write(path, body);
    if (withSort) this.sharedHasSort = true;
  }

  /**
   * Picks up a shared file that has changed underneath us, which is what a
   * sync delivering another device's grids looks like from here.
   */
  private watchShared(): void {
    const reread = async (path: string): Promise<void> => {
      if (path !== this.sharedPath()) return;
      let body: string;
      try {
        body = await this.app.vault.adapter.read(this.sharedPath());
      } catch {
        return;
      }
      // Our own write coming back. Acting on it would be harmless but would
      // rebuild every open wall for nothing.
      if (body === this.wroteShared) return;
      const raw = extractShared(body);
      if (raw === null) return;
      this.sharedHasSort = hasSortKeys(raw);
      this.settings = withShared(this.settings, parseShared(raw, sharedOf(this.settings)));
      // Now what is on disk, as far as this device knows, so the next save
      // does not write the same thing straight back at whoever sent it.
      this.wroteShared = body;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID)) {
        if (leaf.view instanceof OrikoView) leaf.view.refreshGrids();
      }
    };

    this.registerEvent(this.app.vault.on("modify", (file) => void reread(file.path)));
    this.registerEvent(this.app.vault.on("create", (file) => void reread(file.path)));
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<OrikoSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    // Object.assign copies the reference, not the array. Without this, a vault
    // with no saved grids yet would push straight into DEFAULT_SETTINGS, and
    // the module-level default would start carrying real user data.
    this.settings.grids = [...(this.settings.grids ?? [])];
    this.settings.filterProperties = [
      ...(this.settings.filterProperties ?? DEFAULT_SETTINGS.filterProperties),
    ];
    // The declaration lists are pushed onto by the settings tab. The same
    // copy, for the same reason as the grids above.
    this.settings.sortCategories = [...(this.settings.sortCategories ?? [])];
    this.settings.sortTags = [...(this.settings.sortTags ?? [])];
    // A stage that no longer exists, or a hand-edited data.json, lands on the
    // default rather than on a wall laid out to an undefined width.
    if (!isStage(this.settings.tileSize)) this.settings.tileSize = DEFAULT_SETTINGS.tileSize;
    setToolOverrides({ ytdlp: this.settings.ytdlpPath, ffmpeg: this.settings.ffmpegPath });
  }

  async saveSettings(): Promise<void> {
    // The vault's half goes to the vault and is kept out of data.json, so
    // there is one place a grid is defined rather than two that can disagree.
    const local = { ...this.settings } as Partial<OrikoSettings>;
    for (const key of Object.keys(sharedOf(this.settings))) {
      delete local[key as keyof OrikoSettings];
    }
    await this.saveData(local);
    await this.writeShared();
    setToolOverrides({ ytdlp: this.settings.ytdlpPath, ffmpeg: this.settings.ffmpegPath });

    // Saving is also how an open wall hears about it. Every caller of this
    // already means "the settings have changed", so there is no second thing
    // for the settings tab to remember to call, and no way for a new toggle
    // to be added that silently does not take effect.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID)) {
      if (leaf.view instanceof OrikoView) leaf.view.applyLiveSettings();
    }
  }
}
