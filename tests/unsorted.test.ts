import { describe, expect, it } from "vitest";
import { noteState, pickCandidates } from "../src/core/unsorted";

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
