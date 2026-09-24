import { AbstractInputSuggest, App, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { slotCandidates, surveyProperties } from "./core/facet-catalog";
import { usableCategories } from "./core/classify";
import type { SortCategory } from "./core/classify";
import { facetLabel } from "./core/filter";
import { OrikoView, VIEW_TYPE_GRID } from "./view";
import type OrikoPlugin from "./main";

/**
 * Type-ahead over the property names already in the vault.
 *
 * Obsidian's own suggester rather than a <datalist>: that is drawn by Chromium
 * and takes no styling at all, so it lands on the settings pane as a black box
 * in a bold serif stack, matching neither the theme nor anything else on the
 * page. This renders in the same popover the file and folder suggesters use.
 */
class PropertySuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    input: HTMLInputElement,
    private options: string[],
    private pick: (key: string) => void
  ) {
    super(app, input);
  }

  protected getSuggestions(query: string): string[] {
    const wanted = query.trim().toLowerCase();
    if (!wanted) return this.options;
    return this.options.filter((key) => key.toLowerCase().includes(wanted));
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }

  selectSuggestion(value: string): void {
    this.setValue(value);
    this.close();
    this.pick(value);
  }
}

export class OrikoSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: OrikoPlugin) {
    super(app, plugin);
  }

  /**
   * Saves, repaints any open wall so a new facet appears without a reload,
   * and redraws this tab so a property moves between the enabled list and the
   * one below it.
   */
  private async commitFilterProperties(properties: string[]): Promise<void> {
    this.plugin.settings.filterProperties = properties;
    await this.plugin.saveSettings();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID)) {
      if (leaf.view instanceof OrikoView) leaf.view.refreshFacets();
    }
    this.update();
  }

  /** Same shape as above: every open wall redraws its badges in place. */
  private async commitTileSlot(key: "tileDate" | "tileProperty", value: string): Promise<void> {
    this.plugin.settings[key] = value;
    await this.plugin.saveSettings();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GRID)) {
      if (leaf.view instanceof OrikoView) leaf.view.refreshTileProperties();
    }
  }


  /**
   * Which properties a dropdown offers. Dates and everything else are
   * separated by what the vault actually holds under each key, the same
   * test the filter menu uses to decide a facet is a date. The current
   * choice is always listed, so a key that has since left the vault still
   * shows as chosen rather than silently reading as None.
   */
  private slotOptions(dates: boolean, current: string): Record<string, string> {
    const keys = slotCandidates(this.plugin.index.records(), dates, current);
    const options: Record<string, string> = { "": "None" };
    for (const key of keys) options[key] = facetLabel(key);
    return options;
  }

  private paintFilterProperties(containerEl: HTMLElement): void {
    this.paintPropertyList(containerEl, {
      enabled: this.plugin.settings.filterProperties,
      intro: "What the filter menu offers, alongside media type and source.",
      empty: "None. The menu still offers Media type and Source.",
      commit: (keys) => this.commitFilterProperties(keys),
    });
  }

  /**
   * A list of property names as chips, with a type-ahead to add one. Shared
   * by the filter list and the tile list, which are the same control over
   * two settings.
   */
  private paintPropertyList(
    containerEl: HTMLElement,
    spec: {
      enabled: string[];
      intro: string;
      empty: string;
      commit: (keys: string[]) => Promise<void>;
    }
  ): void {
    const enabled = spec.enabled;

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: spec.intro,
    });

    // Chips rather than a settings row each. One row per property put a
    // full-height card on screen for every key in the vault, which is a wall
    // of thirteen cards to express a list of two words.
    const chips = containerEl.createDiv({ cls: "pg-props" });
    for (const key of enabled) {
      const chip = chips.createSpan({ cls: "pg-prop" });
      chip.createSpan({ text: facetLabel(key) });
      const remove = chip.createEl("button", { cls: "pg-prop-remove", text: "\u00d7" });
      remove.setAttribute("aria-label", `Remove ${facetLabel(key)}`);
      remove.onclick = () => void spec.commit(enabled.filter((k) => k !== key));
    }
    if (enabled.length === 0) {
      chips.createSpan({ cls: "pg-props-empty", text: spec.empty });
    }

    // Suggested first, so type-ahead puts the properties worth filtering by at
    // the top of the list. The counts behind that ranking are not shown: they
    // are how the order is decided, not something to read.
    const available = surveyProperties(this.plugin.index.records())
      .filter((stat) => !enabled.includes(stat.key))
      .map((stat) => stat.key);

    // Set while the text control is built, so the Add button beside it can
    // commit the same value the Enter key does.
    let addTyped: (() => void) | null = null;

    new Setting(containerEl)
      .setName("Add a property")
      .setDesc("Suggestions come from your clippings. Any name works.")
      .addText((text) => {
        text.setPlaceholder("Property name");

        // One shot: commit re-renders the tab and rebuilds these closures, so
        // a suggester pick and the Enter key both landing would otherwise add
        // against a list that is already stale.
        let done = false;
        const add = (key: string): void => {
          const name = key.trim();
          if (done || !name || enabled.includes(name)) return;
          done = true;
          void spec.commit([...enabled, name]);
        };

        new PropertySuggest(this.app, text.inputEl, available, add);

        text.inputEl.onkeydown = (event: KeyboardEvent) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          add(text.getValue());
        };
        addTyped = () => add(text.getValue());
      })
      .addButton((button) => button.setButtonText("Add").onClick(() => addTyped?.()));
  }

  /**
   * The whole tab, declaratively, so every setting is reachable from
   * Obsidian's settings search. Values flow through getControlValue and
   * setControlValue below, which is where the byte-to-megabyte translation
   * and the folder-change side effects live.
   */
  /**
   * One row per declared category or tag, two fields each. Obsidian's own list
   * control supplies the add, delete and drag-to-reorder affordances and lays
   * itself out for a phone, which is where a lot of clipping happens.
   *
   * The description is not a label: it is what the model matches a clipping
   * against, so it sits in the row beside the name rather than in the
   * setting's own description.
   */
  private declarationList(
    heading: string,
    key: "sortCategories" | "sortTags",
    emptyState: string,
    addLabel: string
  ): SettingDefinitionItem {
    // Read afresh on every edit rather than captured: the lists are shared
    // through _Oriko.md now, and a sync arriving while this tab is open swaps
    // in a new array. An edit made to the old one would be saved nowhere.
    const list = (): SortCategory[] => this.plugin.settings[key];
    const save = (): Promise<void> => this.plugin.saveSettings();
    const saveAndRedraw = (): void => {
      void save().then(() => this.update());
    };
    return {
      type: "list",
      heading,
      emptyState,
      addItem: {
        name: addLabel,
        action: () => {
          list().push({ name: "", description: "" });
          saveAndRedraw();
        },
      },
      onDelete: (index: number) => {
        list().splice(index, 1);
        saveAndRedraw();
      },
      onReorder: (from: number, to: number) => {
        const [moved] = list().splice(from, 1);
        list().splice(to, 0, moved);
        void save();
      },
      items: list().map((entry, index) => ({
        name: entry.name || addLabel,
        render: (setting: Setting) => {
          setting
            .addText((text) =>
              text
                .setPlaceholder("Name")
                .setValue(entry.name)
                .onChange((value) => {
                  const row = list()[index];
                  if (!row) return;
                  row.name = value;
                  void save();
                })
            )
            .addText((text) =>
              text
                .setPlaceholder("What belongs here")
                .setValue(entry.description)
                .onChange((value) => {
                  const row = list()[index];
                  if (!row) return;
                  row.description = value;
                  void save();
                })
            );
        },
      })),
    };
  }

  /**
   * The categories as they stand when the tab is drawn. A name edited since
   * then only shows up on the next draw, which is why the stored choice is kept
   * in the list when it no longer matches: showing another option in its place
   * would read as though the setting had changed.
   */
  private fallbackOptions(): Record<string, string> {
    const { sortCategories, sortFallback } = this.plugin.settings;
    const options: Record<string, string> = { "": "Leave them unsorted" };
    for (const item of usableCategories(sortCategories)) options[item.name] = item.name;
    if (sortFallback && !(sortFallback in options)) {
      options[sortFallback] = `${sortFallback} (no longer a category)`;
    }
    return options;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Clippings folder",
        desc: "Every note in this folder shows up on the wall.",
        control: { type: "folder", key: "clippingsFolder", defaultValue: "Clippings" },
      },
      {
        name: "Attachment folder",
        desc: "Where the downloaded copies of pictures and video go.",
        control: {
          type: "folder",
          key: "attachmentFolder",
          defaultValue: "Attachments/Clippings",
        },
      },
      {
        type: "group",
        heading: "Wall",
        items: [
          {
            name: "Autoplay videos",
            desc: "Video tiles play while they are on screen. A wall of them uses a lot of memory, and Reduce Motion always wins.",
            control: { type: "toggle", key: "autoplayVideo" },
          },
          {
            name: "Add new clippings automatically",
            desc: "New clippings turn up on the wall as they are saved. With this off, they wait for a relaunch or the Rescan clippings folder command.",
            control: { type: "toggle", key: "watchClippings" },
          },
        ],
      },
      {
        type: "group",
        heading: "Downloads",
        items: [
          {
            name: "Download media automatically",
            desc: "Keeps a copy of every picture and video, so a clipping still works once the page it came from goes dark. Happens quietly as clippings arrive.",
            control: { type: "toggle", key: "archiveOnCreate" },
          },
          {
            name: "Use community media resolvers",
            desc: "X and Instagram never hand out their video links, so getting the video means asking a community mirror (fxtwitter, kkinstagram) and sending it your link. With this off, those posts fall back to the site's own poster image.",
            control: { type: "toggle", key: "useResolvers" },
          },
          {
            name: "Shared clips go to",
            desc: "Where a link shared from another app lands. Anything you clip on the wall goes to the grid you are on.",
            control: {
              type: "dropdown",
              key: "sharedClipTarget",
              options: {
                "last-opened": "Last opened grid",
                home: `${this.plugin.settings.homeGridName} (home)`,
                ask: "Ask each time",
              },
            },
          },
          {
            name: "Maximum file size (MB)",
            desc: "Skip downloads larger than this.",
            control: { type: "number", key: "maxSizeMb" },
          },
          {
            name: "Preview width (px)",
            desc: "How wide the stills made from videos and GIFs come out.",
            control: { type: "number", key: "thumbnailWidth" },
          },
          {
            name: "yt-dlp path",
            desc: "Where yt-dlp lives, which is what fetches a post's own video. Leave it empty and Oriko goes looking (PATH, Homebrew, winget, scoop, chocolatey, ~/.local/bin).",
            control: { type: "text", key: "ytdlpPath" },
          },
          {
            name: "ffmpeg path",
            desc: "Where ffmpeg lives, which makes previews for anything Obsidian cannot play. Leave it empty and Oriko goes looking the same way.",
            control: { type: "text", key: "ffmpegPath" },
          },
        ],
      },
      {
        type: "group",
        heading: "Grids",
        items: [
          {
            name: "Grid settings apply to",
            desc: "Whether every wall looks the same, or each grid keeps its own tile size, corners, filter properties and autoplay. Per grid, you set those from Grid settings on the wall, and anything a grid has not set follows what is here.",
            aliases: ["per grid", "scope", "shared", "look"],
            control: {
              type: "dropdown",
              key: "gridLookScope",
              options: {
                all: "All grids",
                grid: "Per grid",
              },
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Show on tiles",
        items: [
          {
            name: "Top corner",
            desc: "A date, shown as how long ago when you hover a tile.",
            aliases: ["badges", "hover", "date"],
            render: (setting) => {
              setting.addDropdown((dropdown) =>
                dropdown
                  .addOptions(this.slotOptions(true, this.plugin.settings.tileDate))
                  .setValue(this.plugin.settings.tileDate)
                  .onChange((value) => void this.commitTileSlot("tileDate", value))
              );
            },
          },
          {
            name: "Bottom corner",
            desc: "Any other property, its values in one pill. Anything too long ticks across while you hover.",
            aliases: ["badges", "hover", "tags"],
            render: (setting) => {
              setting.addDropdown((dropdown) =>
                dropdown
                  .addOptions(this.slotOptions(false, this.plugin.settings.tileProperty))
                  .setValue(this.plugin.settings.tileProperty)
                  .onChange((value) => void this.commitTileSlot("tileProperty", value))
              );
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Auto-sorting",
        items: [
          {
            name: "Sort new clippings",
            desc: "Ask a model which of your categories a clipping belongs to, before the note is written. Nothing leaves your vault until you set an endpoint below.",
            control: { type: "toggle", key: "autoSort" },
          },
          {
            name: "File sorted clippings by",
            desc: "Where the decided category goes. The categories property is written either way, so changing this later does not strand what is already filed.",
            control: {
              type: "dropdown",
              key: "sortDestination",
              options: {
                property: "The categories property only",
                subfolder: "A subfolder of the clippings folder",
                grid: "An Oriko grid of the same name",
                folder: "An Oriko folder of the same name",
              },
            },
          },
          {
            name: "When the model is unsure, file under",
            desc: "A category for clippings the model answered on but would not commit to, such as MISC. It only applies when a model actually replied: an endpoint that never answered still leaves the clipping unsorted, so a broken setup stays visible.",
            control: {
              type: "dropdown",
              key: "sortFallback",
              options: this.fallbackOptions(),
            },
          },
          {
            name: "Decision endpoint",
            desc: "A model that answers typed questions: a Laya sidecar on your own machine, or a hosted service. Laya runs offline and sends nothing anywhere.",
            control: { type: "text", key: "sortEndpoint" },
          },
          {
            name: "Decision endpoint key",
            desc: "Leave empty for a local sidecar. Stored as plain text in this plugin's data file, as with every Obsidian plugin that holds a key.",
            control: { type: "text", key: "sortApiKey" },
          },
          {
            name: "Language model base URL",
            desc: "Any OpenAI-compatible endpoint, asked when the decision endpoint is unsure or unreachable. It can invent tags, which the decision model cannot.",
            control: { type: "text", key: "sortLlmBaseUrl" },
          },
          {
            name: "Language model",
            desc: "The model name to send, such as gpt-4o-mini or llama3.2.",
            control: { type: "text", key: "sortLlmModel" },
          },
          {
            name: "Language model key",
            desc: "Stored as plain text in this plugin's data file.",
            control: { type: "text", key: "sortLlmApiKey" },
          },
          {
            name: "Certainty needed",
            desc: "Between 0 and 1, and it only governs the decision endpoint, which reports a real probability per option. A language model reports none worth trusting, so its first answer is taken as it comes. Measure this on your own clippings before relying on it.",
            control: { type: "number", key: "sortThreshold" },
          },
        ],
      },
      this.declarationList(
        "Categories",
        "sortCategories",
        "No categories yet. Sorting stays off until there is at least one. Keep the list short: accuracy drops past about twenty options, and every description shares one budget of roughly 190 tokens.",
        "Add category"
      ),
      this.declarationList(
        "Tags",
        "sortTags",
        "No tags yet. The decision model can only answer yes or no about tags you name here; a language model invents its own.",
        "Add tag"
      ),
      {
        type: "group",
        heading: "Filter properties",
        items: [
          {
            name: "Filter properties",
            aliases: ["facets"],
            render: (setting) => {
              const el = setting.settingEl;
              el.empty();
              el.addClass("pg-props-setting");
              this.paintFilterProperties(el);
            },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (key === "maxSizeMb") return Math.round(this.plugin.settings.maxBytes / 1048576);
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  setControlValue(key: string, value: unknown): void | Promise<void> {
    const settings = this.plugin.settings;
    switch (key) {
      case "clippingsFolder": {
        settings.clippingsFolder = String(value).trim() || "Clippings";
        return this.plugin.saveSettings().then(() => this.plugin.index.rebuild());
      }
      case "attachmentFolder": {
        settings.attachmentFolder = String(value).trim() || "Attachments/Clippings";
        break;
      }
      case "maxSizeMb": {
        const mb = Number(value);
        if (!Number.isFinite(mb) || mb <= 0) return;
        settings.maxBytes = Math.round(mb * 1048576);
        break;
      }
      case "sortThreshold": {
        const threshold = Number(value);
        // Out-of-range silently ignored rather than clamped: a typed 6 is a
        // slip, and clamping it to 1 would quietly stop every clip sorting.
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) return;
        settings.sortThreshold = threshold;
        break;
      }
      case "thumbnailWidth": {
        const width = Number(value);
        if (!Number.isFinite(width) || width < 100) return;
        settings.thumbnailWidth = Math.round(width);
        break;
      }
      case "gridLookScope": {
        settings.gridLookScope = value === "grid" ? "grid" : "all";
        // Nothing is cleared on the way out. A grid keeps what it was given,
        // unread, and has it back if the switch comes back: the switch is not
        // a door you can only walk through once. Saving is what redraws the
        // open walls, density, corners and autoplay together.
        break;
      }
      default:
        (settings as unknown as Record<string, unknown>)[key] = value;
    }
    return this.plugin.saveSettings();
  }
}
