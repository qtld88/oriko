import { describe, expect, it } from "vitest";
import { describeVideoProblems, ytdlpProblem } from "../src/core/video-problems";
import type { VideoProblem } from "../src/core/video-problems";

const limits = { maxBytes: 50 * 1048576, timeoutMs: 180000 };

describe("ytdlpProblem", () => {
  it("reads a 403 as the site refusing the download", () => {
    const stderr = "ERROR: unable to download video data: HTTP Error 403: Forbidden\n";
    expect(ytdlpProblem(stderr, false)).toBe("refused");
  });

  it("reads a killed run as timed out, whatever it printed", () => {
    expect(ytdlpProblem("", true)).toBe("timed-out");
  });

  it("stays quiet about a post that simply has no video", () => {
    const stderr = "ERROR: [instagram] C1abc: There is no video in this post\n";
    expect(ytdlpProblem(stderr, false)).toBeNull();
  });
});

describe("describeVideoProblems", () => {
  const refused: VideoProblem = {
    kind: "refused",
    source: "https://www.youtube.com/watch?v=VwjYzfAcGmk",
    title: "I finally learn how to release the golf club for effortless speed!",
  };

  it("says nothing when nothing went wrong", () => {
    expect(describeVideoProblems([], limits)).toEqual([]);
  });

  it("names the clipping, the site, and the fix for a refused download", () => {
    const [message] = describeVideoProblems([refused], limits);
    expect(message).toContain('"I finally learn how to release the golf…"');
    expect(message).toContain("youtube.com");
    expect(message).toContain("yt-dlp");
    expect(message).toContain("Download all clipping media");
  });

  it("falls back to the site when there is no clipping title yet", () => {
    const [message] = describeVideoProblems(
      [{ kind: "timed-out", source: refused.source, title: "" }],
      limits
    );
    expect(message).toContain("the video from youtube.com");
  });

  it("names the site once when a refused video has no title", () => {
    const [message] = describeVideoProblems([{ ...refused, title: "" }], limits);
    expect(message.match(/youtube\.com/g)).toHaveLength(1);
  });

  it("blames the sites together when refusals come from more than one", () => {
    const [message] = describeVideoProblems(
      [refused, { ...refused, source: "https://www.instagram.com/p/C1abc/" }],
      limits
    );
    expect(message).toContain("the sites");
    expect(message).not.toMatch(/,\./);
  });

  it("gives the size, the limit, and where to change it for a video over the limit", () => {
    const [message] = describeVideoProblems(
      [{ kind: "too-large", source: refused.source, title: "Lesson", bytes: 99022596 }],
      limits
    );
    expect(message).toContain("94 MB");
    expect(message).toContain("50 MB");
    expect(message).toContain("Settings → Oriko → Downloads → Maximum file size (MB)");
  });

  it("says how long it waited for a download that ran out of time", () => {
    const [message] = describeVideoProblems(
      [{ kind: "timed-out", source: refused.source, title: "Lesson" }],
      limits
    );
    expect(message).toContain('"Lesson"');
    expect(message).toContain("3 minutes");
  });

  it("folds several problems of one kind into a single message", () => {
    const messages = describeVideoProblems(
      [refused, { ...refused, title: "I Learn the Secret to Effortless Speed..." }],
      limits
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("2 videos");
    expect(messages[0]).toContain("I finally learn");
  });

  it("keeps the punctuation clean when several videos are over the limit", () => {
    const [message] = describeVideoProblems(
      [
        { kind: "too-large", source: refused.source, title: "Lesson one", bytes: 99022596 },
        { kind: "too-large", source: refused.source, title: "Lesson two", bytes: 132129559 },
      ],
      limits
    );
    expect(message).toContain('2 videos, including "Lesson one",');
    expect(message).not.toMatch(/,\./);
  });

  it("gives each kind of problem its own message", () => {
    const messages = describeVideoProblems(
      [
        refused,
        { kind: "too-large", source: refused.source, title: "Lesson", bytes: 99022596 },
      ],
      limits
    );
    expect(messages).toHaveLength(2);
  });
});
