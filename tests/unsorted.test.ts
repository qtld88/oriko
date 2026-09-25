import { describe, expect, it } from "vitest";
import {
  applySortPatch,
  AttemptLog,
  emptyCounts,
  handSorted,
  noteResult,
  noteState,
  pickCandidates,
  sortPatch,
  sweepSummary,
} from "../src/core/unsorted";
import type { Verdict } from "../src/core/classify";

describe("pickCandidates", () => {
  const entries = [
    { path: "Clippings/a.md", frontmatter: { unsorted: true } },
    { path: "Clippings/DESIGN/b.md", frontmatter: { unsorted: true } },
    { path: "Clippings/c.md", frontmatter: { unsorted: "true" } },
    { path: "Clippings/d.md", frontmatter: { categories: ["DESIGN"] } },
    { path: "Clippings/e.md", frontmatter: undefined },
    { path: "Notes/f.md", frontmatter: { unsorted: true } },
    { path: "Clippings/_Oriko.md", frontmatter: { unsorted: true } },
    { path: "Clippings/g.canvas", frontmatter: { unsorted: true } },
  ];

  it("selects marked notes under the clippings folder, subfolders included", () => {
    expect(pickCandidates(entries, "Clippings")).toEqual([
      "Clippings/a.md",
      "Clippings/DESIGN/b.md",
    ]);
  });

  it("does not accept the string \"true\", which no Oriko build writes", () => {
    expect(pickCandidates(entries, "Clippings")).not.toContain("Clippings/c.md");
  });

  it("skips files starting with an underscore, as the index does", () => {
    expect(pickCandidates(entries, "Clippings")).not.toContain("Clippings/_Oriko.md");
  });

  it("finds nothing outside the folder it is given", () => {
    expect(pickCandidates(entries, "Elsewhere")).toEqual([]);
  });
});

describe("noteState", () => {
  it("reads the description, as capture does", () => {
    expect(noteState({ title: "A lamp", description: "Brass desk lamp", source: "https://x.com" })).toBe(
      "Brass desk lamp"
    );
  });

  it("falls back to the title when there is no description", () => {
    expect(noteState({ title: "A lamp", description: "" })).toBe("A lamp");
  });

  it("ignores values that are not strings rather than sorting on them", () => {
    expect(noteState({ title: 42, description: ["x"] })).toBe("");
  });
});

const decided = (category: string, tags: string[] = []): Verdict => ({
  category,
  tags,
  probability: 0.9,
});

describe("handSorted", () => {
  it("is true for a note a person gave a category", () => {
    expect(handSorted({ unsorted: true, categories: ["ART"] })).toBe(true);
    expect(handSorted({ unsorted: true, categories: "ART" })).toBe(true);
  });

  it("is false for an empty or blank category list", () => {
    expect(handSorted({ unsorted: true })).toBe(false);
    expect(handSorted({ unsorted: true, categories: [] })).toBe(false);
    expect(handSorted({ unsorted: true, categories: [""] })).toBe(false);
    expect(handSorted({ unsorted: true, categories: null })).toBe(false);
  });
});

describe("sortPatch", () => {
  it("removes the marker and sets the category", () => {
    expect(sortPatch({ unsorted: true }, decided("DESIGN", ["lamp"]), "property")).toEqual({
      remove: ["unsorted"],
      set: { categories: ["DESIGN"] },
      tags: ["lamp"],
      subfolder: "",
    });
  });

  it("sets the grid for the grid destination", () => {
    expect(sortPatch({ unsorted: true }, decided("DESIGN"), "grid")?.set).toEqual({
      categories: ["DESIGN"],
      grid: "DESIGN",
    });
  });

  it("sets the folder for the folder destination", () => {
    expect(sortPatch({ unsorted: true }, decided("DESIGN"), "folder")?.set).toEqual({
      categories: ["DESIGN"],
      folder: "DESIGN",
    });
  });

  it("keeps a grid the note already had, as capture does", () => {
    expect(
      sortPatch({ unsorted: true, grid: "Manga" }, decided("DESIGN"), "grid")?.set
    ).toEqual({ categories: ["DESIGN"] });
  });

  it("returns the subfolder only for the subfolder destination", () => {
    expect(sortPatch({ unsorted: true }, decided("DESIGN"), "subfolder")?.subfolder).toBe("DESIGN");
    expect(sortPatch({ unsorted: true }, decided("DESIGN"), "grid")?.subfolder).toBe("");
  });

  it("only clears the marker on a note a person already sorted", () => {
    expect(
      sortPatch({ unsorted: true, categories: ["ART"] }, decided("DESIGN", ["lamp"]), "subfolder")
    ).toEqual({ remove: ["unsorted"], set: {}, tags: [], subfolder: "" });
  });

  it("is null for an undecided verdict: the note is left exactly as it is", () => {
    expect(sortPatch({ unsorted: true }, decided(""), "property")).toBeNull();
  });
});

describe("applySortPatch", () => {
  it("removes the marker and sets the keys", () => {
    const front: Record<string, unknown> = { title: "A lamp", unsorted: true };
    applySortPatch(front, { remove: ["unsorted"], set: { categories: ["DESIGN"] }, tags: [], subfolder: "" });
    expect(front).toEqual({ title: "A lamp", categories: ["DESIGN"] });
  });

  it("merges tags without duplicating any already there", () => {
    const front: Record<string, unknown> = { tags: ["clippings", "lamp"], unsorted: true };
    applySortPatch(front, { remove: ["unsorted"], set: {}, tags: ["lamp", "brass"], subfolder: "" });
    expect(front.tags).toEqual(["clippings", "lamp", "brass"]);
  });

  it("reads a single tag written as a string", () => {
    const front: Record<string, unknown> = { tags: "clippings", unsorted: true };
    applySortPatch(front, { remove: ["unsorted"], set: {}, tags: ["lamp"], subfolder: "" });
    expect(front.tags).toEqual(["clippings", "lamp"]);
  });

  it("leaves tags alone when there are none to add", () => {
    const front: Record<string, unknown> = { tags: "clippings", unsorted: true };
    applySortPatch(front, { remove: ["unsorted"], set: {}, tags: [], subfolder: "" });
    expect(front.tags).toBe("clippings");
  });
});

describe("AttemptLog", () => {
  it("lets a note never tried through", () => {
    expect(new AttemptLog().due("Clippings/a.md", 100)).toBe(true);
  });

  it("skips a note while its mtime matches the last attempt", () => {
    const log = new AttemptLog();
    log.record("Clippings/a.md", 100);
    expect(log.due("Clippings/a.md", 100)).toBe(false);
  });

  it("retries a note once it has changed, as a person's edit does", () => {
    const log = new AttemptLog();
    log.record("Clippings/a.md", 100);
    expect(log.due("Clippings/a.md", 250)).toBe(true);
  });

  it("skips a note capture registered, so a failed clip is not retried a moment later", () => {
    const log = new AttemptLog();
    // What CaptureService does right after vault.create.
    log.record("Clippings/new.md", 300);
    expect(log.due("Clippings/new.md", 300)).toBe(false);
  });
});

describe("noteResult", () => {
  it.each([
    ["sorted", "sorted"],
    ["fallback", "fallback"],
    ["unsure", "unsure"],
    ["unavailable", "unreachable"],
    ["no-text", "noText"],
  ] as const)("counts %s as %s", (outcome, result) => {
    expect(noteResult(outcome)).toBe(result);
  });

  it.each(["no-categories", "no-engine", "off"] as const)("stops the run on %s", (outcome) => {
    expect(noteResult(outcome)).toBe("stop");
  });
});

describe("sweepSummary", () => {
  it("names every count in one line", () => {
    const counts = { ...emptyCounts(), sorted: 31, fallback: 3, unsure: 4, unreachable: 2 };
    expect(sweepSummary(counts, "MISC")).toBe("31 sorted · 3 filed under MISC · 4 unsure · 2 unreachable");
  });

  it("omits the counts that are zero", () => {
    expect(sweepSummary({ ...emptyCounts(), sorted: 2, failed: 1 }, "")).toBe("2 sorted · 1 failed");
  });

  it("names notes with no text to read", () => {
    expect(sweepSummary({ ...emptyCounts(), noText: 5 }, "")).toBe("5 with no text");
  });

  it("says so when nothing happened at all", () => {
    expect(sweepSummary(emptyCounts(), "")).toBe("nothing sorted");
  });
});
