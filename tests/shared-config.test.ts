import { describe, expect, it } from "vitest";
import {
  defaultShared,
  extractShared,
  hasSortKeys,
  isDefaultShared,
  parseShared,
  publishesSort,
  serializeShared,
  sharedOf,
  withShared,
} from "../src/core/shared-config";
import { DEFAULT_SETTINGS } from "../src/core/settings";

const fallback = {
  grids: [{ name: "Manga", icon: "archive" }],
  folders: [],
  homeGridName: "Clippings",
  homeGridIcon: "archive",
  filterProperties: ["categories", "status"],
  sortCategories: [],
  sortTags: [],
  sortDestination: "property" as const,
  sortFallback: "",
};

describe("sharedOf and withShared", () => {
  it("carries the vault's half and nothing else", () => {
    const settings = { ...DEFAULT_SETTINGS, grids: fallback.grids, tileSize: "s" as const };
    const shared = sharedOf(settings);
    expect(shared.grids).toEqual(fallback.grids);
    expect(Object.keys(shared).sort()).toEqual([
      "filterProperties",
      "folders",
      "grids",
      "homeGridIcon",
      "homeGridLook",
      "homeGridName",
      "sortCategories",
      "sortDestination",
      "sortFallback",
      "sortTags",
    ]);
  });

  it("carries a grid's look, so a wall looks the same on the phone", () => {
    const grids = [{ name: "Manga", icon: "book", look: { tileDate: "published" } }];
    const settings = {
      ...DEFAULT_SETTINGS,
      grids,
      homeGridLook: { tileProperty: "author" },
      // Device-local, both of them: a phone keeps its own.
      tileSize: "s" as const,
      gridTileSizes: { Manga: "xl" as const },
      gridLookScope: "grid" as const,
    };
    const shared = sharedOf(settings);

    expect(shared.grids[0].look).toEqual({ tileDate: "published" });
    expect(shared.homeGridLook).toEqual({ tileProperty: "author" });
    expect(shared).not.toHaveProperty("gridTileSizes");
    expect(shared).not.toHaveProperty("gridLookScope");
  });

  it("keeps a look through the file and drops one edited into nonsense", () => {
    const round = parseShared(
      JSON.parse(
        JSON.stringify({
          grids: [
            { name: "Manga", icon: "book", look: { tileDate: "published" } },
            { name: "Broken", icon: "book", look: "nonsense" },
          ],
          folders: [],
          homeGridName: "Clippings",
          homeGridIcon: "layout-grid",
          homeGridLook: { tileProperty: "author" },
          filterProperties: ["categories"],
        })
      ),
      fallback
    );

    expect(round.grids[0].look).toEqual({ tileDate: "published" });
    // The grid survives; only the unreadable look goes.
    expect(round.grids[1].name).toBe("Broken");
    expect(round.grids[1].look).toBeUndefined();
    expect(round.homeGridLook).toEqual({ tileProperty: "author" });
  });

  it("leaves the device's half alone when merging", () => {
    // The whole point of the split: a phone keeps its own density and its own
    // open grid even as the desktop's grids arrive.
    const local = { ...DEFAULT_SETTINGS, tileSize: "s" as const, autoplayVideo: false, activeGrid: "Manga" };
    const merged = withShared(local, fallback);
    expect(merged.grids).toEqual(fallback.grids);
    expect(merged.tileSize).toBe("s");
    expect(merged.autoplayVideo).toBe(false);
    expect(merged.activeGrid).toBe("Manga");
  });
});

describe("parseShared", () => {
  it("reads a well-formed file", () => {
    const raw = {
      grids: [{ name: "Sites", icon: "bookmark" }],
      homeGridName: "Home",
      homeGridIcon: "layout-grid",
      filterProperties: ["categories"],
    };
    expect(parseShared(raw, fallback)).toEqual({ ...fallback, ...raw, folders: [] });
  });

  it("keeps smart grid rules", () => {
    const rules = { kind: ["image"], categories: ["ios"] };
    const parsed = parseShared({ grids: [{ name: "Shots", icon: "image", rules }] }, fallback);
    expect(parsed.grids[0].rules).toEqual(rules);
  });

  it("falls back on anything that is not an object", () => {
    for (const raw of [null, undefined, 7, "grids", []]) {
      expect(parseShared(raw, fallback)).toEqual(fallback);
    }
  });

  it("keeps the fields it can read and falls back per field", () => {
    // A file synced half-written must not cost the grids beside the bad key.
    const parsed = parseShared(
      { grids: [{ name: "Sites", icon: "bookmark" }], homeGridName: 42 },
      fallback
    );
    expect(parsed.grids).toEqual([{ name: "Sites", icon: "bookmark" }]);
    expect(parsed.homeGridName).toBe(fallback.homeGridName);
  });

  it("drops individual grids that are not grids, keeping the rest", () => {
    const parsed = parseShared(
      { grids: [{ name: "Sites", icon: "bookmark" }, null, { icon: "no-name" }, { name: "", icon: "x" }] },
      fallback
    );
    expect(parsed.grids).toEqual([{ name: "Sites", icon: "bookmark" }]);
  });

  it("turns a grid with unusable rules manual rather than losing it", () => {
    const parsed = parseShared({ grids: [{ name: "Odd", icon: "star", rules: "everything" }] }, fallback);
    expect(parsed.grids).toEqual([]);
  });

  it("refuses a filter property list with a non-string in it", () => {
    const parsed = parseShared({ filterProperties: ["categories", 3] }, fallback);
    expect(parsed.filterProperties).toEqual(fallback.filterProperties);
  });

  it("refuses an empty home grid name, which would leave it unnameable", () => {
    expect(parseShared({ homeGridName: "" }, fallback).homeGridName).toBe(fallback.homeGridName);
  });

});

describe("parseShared folders", () => {
  it("reads folders, keeping only well-formed ones", () => {
    const parsed = parseShared(
      {
        folders: [
          { name: "Kitchen", icon: "folder", grid: "", width: 2 },
          { name: "Bad", icon: "folder", grid: "", width: 7 },
          { name: "", icon: "folder", grid: "", width: 1 },
          null,
        ],
      },
      fallback
    );
    expect(parsed.folders).toEqual([{ name: "Kitchen", icon: "folder", grid: "", width: 2 }]);
  });

  it("reads the retired full width as three columns", () => {
    const parsed = parseShared(
      { folders: [{ name: "Wide", icon: "folder", grid: "", width: "full" }] },
      fallback
    );
    expect(parsed.folders).toEqual([{ name: "Wide", icon: "folder", grid: "", width: 3 }]);
  });

  it("reads an older file without folders as having none", () => {
    expect(parseShared({ grids: [] }, fallback).folders).toEqual([]);
  });

  it("round-trips folders through serialise and extract", () => {
    const shared = {
      ...defaultShared(),
      folders: [{ name: "Film", icon: "clapperboard", grid: "Design", width: 3 as const }],
    };
    expect(parseShared(extractShared(serializeShared(shared, true)), fallback).folders).toEqual(
      shared.folders
    );
  });

  it("counts a vault with folders as configured", () => {
    expect(
      isDefaultShared({
        ...defaultShared(),
        folders: [{ name: "Film", icon: "folder", grid: "", width: 1 }],
      })
    ).toBe(false);
  });
});

describe("isDefaultShared", () => {
  // Whoever writes the file first wins it: every other device reads that file
  // and adopts it. A phone upgraded before the desktop it was configured on
  // must not publish an empty list and take the desktop's grids with it.
  it("is true for a device holding nothing but the defaults", () => {
    expect(isDefaultShared(defaultShared())).toBe(true);
  });

  it("is false as soon as there is a grid to publish", () => {
    expect(isDefaultShared({ ...defaultShared(), grids: fallback.grids })).toBe(false);
  });

  it("is false for a renamed or re-iconed home grid", () => {
    expect(isDefaultShared({ ...defaultShared(), homeGridName: "Shelf" })).toBe(false);
    expect(isDefaultShared({ ...defaultShared(), homeGridIcon: "star" })).toBe(false);
  });

  it("is false for reordered filter properties, which is a real choice", () => {
    const base = defaultShared();
    expect(
      isDefaultShared({ ...base, filterProperties: [...base.filterProperties].reverse() })
    ).toBe(false);
  });
});

describe("sharedOf copies", () => {
  it("does not hand out the array inside the defaults", () => {
    const shared = sharedOf(DEFAULT_SETTINGS);
    shared.grids.push({ name: "Scratch", icon: "star" });
    expect(DEFAULT_SETTINGS.grids).toHaveLength(0);
  });
});

describe("extractShared", () => {
  const shared = {
    ...fallback,
    grids: [{ name: "Shots", icon: "image", rules: { kind: ["image"] } }],
  };

  it("round-trips through the markdown it is written as", () => {
    const written = serializeShared(shared, true);
    expect(parseShared(extractShared(written), defaultShared())).toEqual(shared);
  });

  it("writes a note, not a blob, so every sync carries it", () => {
    const written = serializeShared(shared, true);
    expect(written.startsWith("# Oriko")).toBe(true);
    expect(written).toContain("```json");
  });

  it("reads the bare JSON of the file this replaced", () => {
    expect(extractShared(JSON.stringify(shared))).toEqual(shared);
  });

  it("ignores prose around the block", () => {
    const written = `# Oriko\n\nSome note someone added.\n\n\`\`\`json\n${JSON.stringify(shared)}\n\`\`\`\n\nAnd more after it.\n`;
    expect(extractShared(written)).toEqual(shared);
  });

  it("is null for a file with no configuration in it", () => {
    expect(extractShared("# Oriko\n\nnothing here\n")).toBeNull();
    expect(extractShared("")).toBeNull();
  });

  it("is null for a block that is not valid JSON, rather than throwing", () => {
    expect(extractShared("```json\n{ nope\n```")).toBeNull();
  });
});

describe("sort settings in the shared file", () => {
  const categories = [
    { name: "DESIGN", description: "graphics, typography, objects" },
    { name: "MISC", description: "" },
  ];
  const desktop = {
    ...defaultShared(),
    sortCategories: categories,
    sortTags: [{ name: "lamp", description: "a lamp" }],
    sortDestination: "subfolder" as const,
    sortFallback: "MISC",
  };

  it("carries the vault's sorting and none of the device's", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      sortCategories: categories,
      sortEndpoint: "http://localhost:8765/decide",
      sortApiKey: "secret",
      sortThreshold: 0.8,
    };
    const shared = sharedOf(settings);
    expect(shared.sortCategories).toEqual(categories);
    expect(shared).not.toHaveProperty("sortEndpoint");
    expect(shared).not.toHaveProperty("sortApiKey");
    expect(shared).not.toHaveProperty("sortThreshold");
    expect(shared).not.toHaveProperty("autoSort");
  });

  it("copies the declarations, so editing one does not edit the settings", () => {
    const settings = { ...DEFAULT_SETTINGS, sortCategories: [{ name: "DESIGN", description: "" }] };
    sharedOf(settings).sortCategories[0].name = "ART";
    expect(settings.sortCategories[0].name).toBe("DESIGN");
  });

  it("round-trips through the file", () => {
    const written = serializeShared(desktop, true);
    expect(parseShared(extractShared(written), defaultShared())).toEqual(desktop);
  });

  it("keeps this device's values when an older file says nothing about sorting", () => {
    const parsed = parseShared({ grids: [] }, desktop);
    expect(parsed.sortCategories).toEqual(categories);
    expect(parsed.sortTags).toEqual(desktop.sortTags);
    expect(parsed.sortDestination).toBe("subfolder");
    expect(parsed.sortFallback).toBe("MISC");
  });

  it("clears them when the file holds an empty list: that is a statement", () => {
    const parsed = parseShared({ sortCategories: [], sortTags: [] }, desktop);
    expect(parsed.sortCategories).toEqual([]);
    expect(parsed.sortTags).toEqual([]);
  });

  it("clears the fallback when the file holds an empty one", () => {
    expect(parseShared({ sortFallback: "" }, desktop).sortFallback).toBe("");
  });

  it("drops declarations with no name and keeps the rest", () => {
    const parsed = parseShared(
      { sortCategories: [{ name: "DESIGN", description: "x" }, { description: "no name" }, null, "ART"] },
      desktop
    );
    expect(parsed.sortCategories).toEqual([{ name: "DESIGN", description: "x" }]);
  });

  it("reads a missing description as empty", () => {
    const parsed = parseShared({ sortCategories: [{ name: "DESIGN" }] }, desktop);
    expect(parsed.sortCategories).toEqual([{ name: "DESIGN", description: "" }]);
  });

  it("keeps this device's destination when the file names one that does not exist", () => {
    expect(parseShared({ sortDestination: "cloud" }, desktop).sortDestination).toBe("subfolder");
  });

  it("counts any sorting choice as something to publish", () => {
    expect(isDefaultShared({ ...defaultShared(), sortCategories: categories })).toBe(false);
    expect(isDefaultShared({ ...defaultShared(), sortTags: desktop.sortTags })).toBe(false);
    expect(isDefaultShared({ ...defaultShared(), sortDestination: "grid" })).toBe(false);
    expect(isDefaultShared({ ...defaultShared(), sortFallback: "MISC" })).toBe(false);
  });

  it("tells a file that carries the sort keys from one that does not", () => {
    expect(hasSortKeys({ grids: [] })).toBe(false);
    expect(hasSortKeys({ grids: [], sortFallback: "" })).toBe(true);
    expect(hasSortKeys(null)).toBe(false);
  });
});

describe("publishing the sort keys", () => {
  // A phone upgraded before the desktop reads an old file and holds defaults.
  // Publishing `sortCategories: []` would make the desktop adopt the empty list.
  it("keeps a device holding defaults quiet while the file has no sort keys", () => {
    expect(publishesSort(defaultShared(), false)).toBe(false);
  });

  it("publishes from the device holding real values", () => {
    const shared = { ...defaultShared(), sortCategories: [{ name: "DESIGN", description: "" }] };
    expect(publishesSort(shared, false)).toBe(true);
  });

  it("publishes a clear once the file already carries the keys", () => {
    expect(publishesSort(defaultShared(), true)).toBe(true);
  });

  it("leaves the keys out of the file when told not to publish them", () => {
    const raw = extractShared(serializeShared(defaultShared(), false));
    expect(hasSortKeys(raw)).toBe(false);
    expect(raw).toHaveProperty("grids");
  });

  it("writes them when told to", () => {
    expect(hasSortKeys(extractShared(serializeShared(defaultShared(), true)))).toBe(true);
  });
});
