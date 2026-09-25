import { describe, expect, it } from "vitest";
import { hashUrl } from "../src/core/hash";
import { derivedRenames, planRenames, relink } from "../src/core/rename-media";

const F = "Attachments";
const none = (): boolean => false;
const all = (): boolean => true;

describe("planRenames", () => {
  it("renames an archived file after its note, keeping its hash", () => {
    const renames = planRenames(
      [{ path: "Clippings/My note.md", files: [`${F}/aaaaaaaaaaaa-one.jpg`] }],
      none,
      all,
      none
    );
    expect(renames).toEqual([
      { note: "Clippings/My note.md", from: `${F}/aaaaaaaaaaaa-one.jpg`, to: `${F}/My note aaaaaaaaaaaa.jpg` },
    ]);
  });

  it("names a source video the way the archiver now writes it", () => {
    const [rename] = planRenames(
      [{ path: "Reel.md", files: [`${F}/bbbbbbbbbbbb-video.mp4`] }],
      none,
      all,
      none
    );
    expect(rename.to).toBe(`${F}/Reel bbbbbbbbbbbb.mp4`);
  });

  it("gives a paste a hash of its own path", () => {
    const from = `${F}/pasted-2026-08-18 215104.png`;
    const [rename] = planRenames([{ path: "P.md", files: [from] }], none, all, none);
    expect(rename.to).toBe(`${F}/P ${hashUrl(from)}.png`);
  });

  it("follows a note that was renamed since", () => {
    const [rename] = planRenames(
      [{ path: "New.md", files: [`${F}/Old cccccccccccc.jpg`] }],
      none,
      all,
      none
    );
    expect(rename.to).toBe(`${F}/New cccccccccccc.jpg`);
  });

  it("leaves a file already named right, shared, or not the plugin's", () => {
    const notes = [
      { path: "N.md", files: [`${F}/N dddddddddddd.jpg`, `${F}/shared.jpg`, `${F}/mine.jpg`] },
    ];
    const renames = planRenames(
      notes,
      (f) => f.endsWith("shared.jpg"),
      (f) => !f.endsWith("mine.jpg"),
      none
    );
    expect(renames).toEqual([]);
  });

  it("never lands on a name that is taken", () => {
    const renames = planRenames(
      [{ path: "N.md", files: [`${F}/eeeeeeeeeeee-a.jpg`] }],
      none,
      all,
      (p) => p === `${F}/N eeeeeeeeeeee.jpg`
    );
    expect(renames[0].to).toBe(`${F}/N eeeeeeeeeeee 2.jpg`);
  });
});

describe("derivedRenames", () => {
  it("moves each generated still with its original", () => {
    expect(derivedRenames(`${F}/a-b.mp4`, `${F}/N a.mp4`)).toContainEqual({
      from: `${F}/a-b.poster.webp`,
      to: `${F}/N a.poster.webp`,
    });
  });
});

describe("relink", () => {
  const from = `${F}/aaaaaaaaaaaa-one.jpg`;
  const to = `${F}/My note aaaaaaaaaaaa.jpg`;

  it("rewrites a wikilink embed and the cover property", () => {
    const content = `---\ncover: "${from}"\n---\n![[${from}]]\n`;
    expect(relink(content, from, to)).toBe(`---\ncover: "${to}"\n---\n![[${to}]]\n`);
  });

  it("percent-encodes the new name inside a markdown link", () => {
    expect(relink(`![](${from})`, from, to)).toBe(
      `![](${F}/My%20note%20aaaaaaaaaaaa.jpg)`
    );
  });

  it("leaves a note that does not mention the file alone", () => {
    expect(relink("nothing here", from, to)).toBe("nothing here");
  });
});
