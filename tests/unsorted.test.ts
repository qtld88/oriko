import { describe, expect, it } from "vitest";
import { applySortPatch, handSorted, noteState, pickCandidates, sortPatch } from "../src/core/unsorted";
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
