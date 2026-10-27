import { describe, expect, it } from "vitest";
import { sourceStillCandidates, sourceStillPath } from "../src/core/archive";
import { MediaCache } from "../src/core/cache";
import type { CacheEntry } from "../src/core/cache";
import { hashUrl } from "../src/core/hash";
import { liveRefs, savableFiles } from "../src/core/media-refs";
import { normalizeUrl, sourceStillKeyFor, sourceVideoKeyFor } from "../src/core/normalize";
import { needsPageCover } from "../src/core/page-cover";
import { isProfilePicture } from "../src/core/resolve";
import type { ClippingRecord } from "../src/core/scan";
import { buildTiles } from "../src/core/tile";

const SOURCE = "https://www.threads.com/@jenlhppa/post/DeZ259qjMJo";
const AVATAR =
  "https://scontent-bru2-1.cdninstagram.com/v/t51.82787-19/825320513_18108651815031700_685843371418654252_n.jpg?stp=dst-jpg_s640x640_tt6";
const POST_IMAGE =
  "https://scontent-bru2-1.cdninstagram.com/v/t51.82787-15/845747307_17904639459570581_7704600639866292462_n.jpg?stp=dst-jpg_e15_tt6";

function clipping(over: Partial<ClippingRecord> = {}): ClippingRecord {
  return {
    path: "Clippings/A.md",
    title: "A",
    source: SOURCE,
    description: "",
    categories: [],
    status: "unread",
    created: "2026-10-13",
    cover: "",
    grid: "",
    folder: "",
    media: [{ url: AVATAR, kind: "image", alt: "" }],
    haystack: "",
    properties: {},
    ...over,
  };
}

function entry(key: string, file: string, kind: CacheEntry["kind"] = "image"): CacheEntry {
  return { key, file, thumb: "", kind, width: 720, height: 1280, bytes: 1 };
}

function cacheOf(...entries: CacheEntry[]): MediaCache {
  const cache = new MediaCache();
  for (const e of entries) cache.set(e);
  return cache;
}

describe("isProfilePicture", () => {
  it("knows an avatar by its -19 path", () => {
    expect(isProfilePicture(AVATAR)).toBe(true);
    expect(
      isProfilePicture(
        "https://scontent.cdninstagram.com/v/t51.2885-19/489399413_1009570174026913_2476188559264895649_n.jpg"
      )
    ).toBe(true);
  });

  it("knows one by the efg tag when the path does not say", () => {
    const efg = btoa(JSON.stringify({ vencode_tag: "profile_pic.django.1080.c2" }));
    expect(isProfilePicture(`https://scontent.fbcdn.net/v/abc/1_n.jpg?efg=${efg}`)).toBe(true);
  });

  it("leaves a post's own picture alone", () => {
    expect(isProfilePicture(POST_IMAGE)).toBe(false);
  });

  it("only judges Meta's CDN", () => {
    expect(isProfilePicture("https://example.com/v/t51.2885-19/me.jpg")).toBe(false);
    expect(isProfilePicture("not a url")).toBe(false);
  });
});

describe("source stills", () => {
  it("are keyed apart from the video of the same post", () => {
    expect(sourceStillKeyFor(SOURCE)).toBe(`still:${normalizeUrl(SOURCE)}`);
    expect(sourceStillKeyFor(SOURCE)).not.toBe(sourceVideoKeyFor(SOURCE));
  });

  it("can be adopted from any device under a fixed name", () => {
    const key = sourceStillKeyFor(SOURCE);
    expect(sourceStillCandidates(key, "A")).toEqual([
      `A/${hashUrl(key)}-still.jpg`,
      `A/${hashUrl(key)}-still.webp`,
      `A/${hashUrl(key)}-still.png`,
    ]);
  });

  it("are named after their note, like every other download", () => {
    const key = sourceStillKeyFor(SOURCE);
    expect(sourceStillPath(key, "A", "jpg", "@jenlhppa on Threads")).toBe(
      `A/@jenlhppa on Threads ${hashUrl(key)}.jpg`
    );
    expect(sourceStillCandidates(key, "A", "@jenlhppa on Threads")[0]).toBe(
      `A/@jenlhppa on Threads ${hashUrl(key)}.jpg`
    );
  });
});

describe("a still on the wall", () => {
  it("outranks the avatar the page names as its picture", () => {
    const cache = cacheOf(
      entry(normalizeUrl(AVATAR), "avatar.jpg"),
      entry(sourceStillKeyFor(SOURCE), "still.jpg")
    );
    const [tile] = buildTiles([clipping()], cache);
    expect(tile.filePath).toBe("still.jpg");
  });

  it("gives way to the video itself", () => {
    const cache = cacheOf(
      entry(sourceStillKeyFor(SOURCE), "still.jpg"),
      entry(sourceVideoKeyFor(SOURCE), "video.mp4", "video")
    );
    const [tile] = buildTiles([clipping()], cache);
    expect(tile.filePath).toBe("video.mp4");
  });

  it("gives way to a cover set by hand", () => {
    const cache = cacheOf(entry(sourceStillKeyFor(SOURCE), "still.jpg"));
    const [tile] = buildTiles([clipping({ cover: "mine.jpg" })], cache);
    expect(tile.filePath).toBe("mine.jpg");
  });

  it("makes the page's picture spare", () => {
    const record = { source: SOURCE, media: [] };
    const archived = (key: string) => (key.startsWith("still:") ? "still.jpg" : undefined);
    expect(needsPageCover(record, archived)).toBe(false);
  });
});

describe("a still among the media refs", () => {
  it("stays live, and retires the page's picture", () => {
    const record = clipping();
    const live = liveRefs([record], [entry(sourceStillKeyFor(SOURCE), "still.jpg")]);
    expect(live.keys.has(sourceStillKeyFor(SOURCE))).toBe(true);
    expect(live.keys.has(normalizeUrl(SOURCE))).toBe(false);
  });

  it("is what a clipping hands over when it has no video", () => {
    const cache = cacheOf(
      entry(normalizeUrl(AVATAR), "avatar.jpg"),
      entry(sourceStillKeyFor(SOURCE), "still.jpg")
    );
    expect(savableFiles(clipping(), cache)).toEqual(["still.jpg"]);
  });
});
