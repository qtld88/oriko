import { describe, expect, it } from "vitest";
import { appendedBody, isEmptyPlan, planConformance, tagsOf } from "../src/core/conform";
import type { ConformPlan } from "../src/core/conform";
import { clippingPathFor } from "../src/core/resolve";

const CREATED = new Date(2024, 2, 5, 12).getTime();
const SOURCE = "https://example.com/post";

function plan(
  frontmatter: Record<string, unknown>,
  body = "",
  path = "Notes/My note.md"
): ConformPlan {
  const result = planConformance(path, frontmatter, body, CREATED);
  if (result.kind !== "plan") throw new Error(`skipped: ${result.reason}`);
  return result.plan;
}

const CLIPPED = {
  title: "Done",
  source: SOURCE,
  author: null,
  published: null,
  created: "2024-01-01",
  description: "",
  tags: ["clippings"],
  cover: "Attachments/a.png",
};

describe("planConformance", () => {
  it("fills in every key a clip carries, from the file where it can", () => {
    const p = plan({ source: SOURCE });
    expect(p.add).toEqual({
      title: "My note",
      author: null,
      published: null,
      description: "",
      created: "2024-03-05",
    });
    expect(p.tags).toEqual(["clippings"]);
  });

  it("never replaces a value the note already holds", () => {
    const p = plan({ source: SOURCE, title: "Mine", created: "2020-01-01", description: "kept" });
    expect(p.add.title).toBeUndefined();
    expect(p.add.created).toBeUndefined();
    expect(p.add.description).toBeUndefined();
  });

  it("adds the clippings tag to tags however they are written", () => {
    expect(plan({ source: SOURCE, tags: ["a"] }).tags).toEqual(["a", "clippings"]);
    expect(plan({ source: SOURCE, tags: "a, b" }).tags).toEqual(["a", "b", "clippings"]);
    expect(plan({ source: SOURCE, tags: ["#Clippings"] }).tags).toBeNull();
  });

  it("asks the page for a picture when the body has none", () => {
    expect(plan({ source: SOURCE }).picture).toEqual({ kind: "page", source: SOURCE });
  });

  it("takes the first image in the body over the page", () => {
    const body = "Text\n\n![](https://cdn.example.com/a.jpg)\n\n![](https://cdn.example.com/b.jpg)";
    expect(plan({ source: SOURCE }, body).picture).toEqual({
      kind: "body",
      url: "https://cdn.example.com/a.jpg",
      remote: true,
    });
  });

  it("uses an image already in the vault where it is", () => {
    expect(plan({}, "![[Attachments/a.png]]").picture).toEqual({
      kind: "body",
      url: "Attachments/a.png",
      remote: false,
    });
  });

  it("leaves a note that leads with a video to play it", () => {
    const body = '<video src="https://cdn.example.com/a.mp4"></video>';
    expect(plan({ source: SOURCE }, body).picture).toEqual({ kind: "none" });
  });

  it("needs no picture when a cover is set", () => {
    expect(plan({ source: SOURCE, cover: "a.png" }).picture).toEqual({ kind: "none" });
  });

  it("skips a note with no source and no picture", () => {
    const result = planConformance("a.md", { title: "x" }, "just text", CREATED);
    expect(result.kind).toBe("skip");
  });

  it("does not take a source that is not a link as somewhere to look", () => {
    const result = planConformance("a.md", { source: "a book" }, "", CREATED);
    expect(result.kind).toBe("skip");
  });

  it("links the source only when the body does not already", () => {
    expect(plan({ source: SOURCE }).linkSource).toBe(true);
    expect(plan({ source: SOURCE }, `see ${SOURCE}`).linkSource).toBe(false);
  });

  it("finds nothing to do for a note already in the format", () => {
    expect(isEmptyPlan(plan(CLIPPED, `[${SOURCE}](${SOURCE})`))).toBe(true);
  });
});

describe("tagsOf", () => {
  it("reads nothing from a missing value", () => {
    expect(tagsOf(undefined)).toEqual([]);
  });
});

describe("appendedBody", () => {
  const base: ConformPlan = { add: {}, tags: null, picture: { kind: "none" }, linkSource: false };

  it("leaves the body alone when there is nothing to add", () => {
    expect(appendedBody("keep  \n", base, null, SOURCE)).toBe("keep  \n");
  });

  it("appends the page picture and the source after the text", () => {
    const p: ConformPlan = { ...base, picture: { kind: "page", source: SOURCE }, linkSource: true };
    expect(appendedBody("\nText\n\n", p, "Att/a.png", SOURCE)).toBe(
      `\nText\n\n![[Att/a.png]]\n\n[${SOURCE}](${SOURCE})\n`
    );
  });

  it("embeds the page picture that stood in for a body image", () => {
    const p: ConformPlan = {
      ...base,
      picture: { kind: "body", url: "https://cdn.example.com/dead.jpg", remote: true },
    };
    expect(appendedBody("Text", p, "Att/page.png", SOURCE)).toBe("Text\n\n![[Att/page.png]]\n");
  });

  it("does not embed a body image a second time", () => {
    const p: ConformPlan = {
      ...base,
      picture: { kind: "body", url: "https://cdn.example.com/a.jpg", remote: true },
    };
    expect(appendedBody("Text", p, null, SOURCE)).toBe("Text");
  });

  it("writes into an empty body without leading blank lines", () => {
    const p: ConformPlan = { ...base, linkSource: true };
    expect(appendedBody("", p, null, SOURCE)).toBe(`[${SOURCE}](${SOURCE})\n`);
  });
});

describe("clippingPathFor", () => {
  it("names the note after its title in the clippings folder", () => {
    expect(clippingPathFor("Clippings", "A: title", SOURCE, () => false)).toBe(
      "Clippings/A title.md"
    );
  });

  it("numbers past names already taken", () => {
    const taken = new Set(["Clippings/A.md", "Clippings/A 2.md"]);
    expect(clippingPathFor("Clippings", "A", SOURCE, (p) => taken.has(p))).toBe(
      "Clippings/A 3.md"
    );
  });
});
