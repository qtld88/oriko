import { App, FuzzySuggestModal, TFolder } from "obsidian";

/** Picks one folder of the vault, for a command that works on a folder. */
export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private onPick: (folder: TFolder) => void
  ) {
    super(app);
    this.setPlaceholder("Folder to format into clippings");
  }

  getItems(): TFolder[] {
    return this.app.vault.getAllFolders(true);
  }

  getItemText(folder: TFolder): string {
    return folder.isRoot() ? "/" : folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onPick(folder);
  }
}
