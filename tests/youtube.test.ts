import { describe, expect, it } from "vitest";
import { youtubeVideoId } from "../src/core/page-cover";
import { buildNote } from "../src/core/resolve";
import {
  parseCaptions,
  parsePlayerResponse,
  transcriptMarkdown,
} from "../src/core/youtube";

describe("youtubeVideoId", () => {
  it("reads watch, share and shorts links", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=SeQXCpZhbjc")).toBe("SeQXCpZhbjc");
    expect(youtubeVideoId("https://youtu.be/SeQXCpZhbjc?si=x")).toBe("SeQXCpZhbjc");
    expect(youtubeVideoId("https://youtube.com/shorts/SeQXCpZhbjc")).toBe("SeQXCpZhbjc");
    expect(youtubeVideoId("https://example.com/watch?v=SeQXCpZhbjc")).toBeNull();
  });
});

describe("parsePlayerResponse", () => {
  const tracks = [
    { baseUrl: "https://x/en", languageCode: "en", kind: undefined },
    { baseUrl: "https://x/fr-asr", languageCode: "fr", kind: "asr" },
    { baseUrl: "https://x/fr", languageCode: "fr" },
  ];
  const response = (captionTracks: unknown[]) => ({
    videoDetails: { title: "T", author: "A", shortDescription: "line 1\nline 2" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks } },
  });

  it("keeps the full description and prefers written captions in the spoken language", () => {
    expect(parsePlayerResponse(response(tracks))).toEqual({
      title: "T",
      author: "A",
      description: "line 1\nline 2",
      captionUrl: "https://x/fr",
    });
  });

  it("falls back to the automatic track over a translation", () => {
    expect(parsePlayerResponse(response(tracks.slice(0, 2)))?.captionUrl).toBe("https://x/fr-asr");
  });

  it("returns null without video details", () => {
    expect(parsePlayerResponse({ playabilityStatus: { status: "ERROR" } })).toBeNull();
  });
});

describe("parseCaptions", () => {
  it("reads srv3 cues with word runs", () => {
    const xml =
      '<?xml version="1.0" ?><timedtext format="3"><body>' +
      '<p t="240" d="4640" w="1"><s ac="0">Jusqu&#39;où</s><s t="400"> peut-on</s></p>' +
      '<p t="2149" d="2731" w="1" a="1">\n</p>' +
      '<p t="65000" d="1000"><s>aller</s></p></body></timedtext>';
    expect(parseCaptions(xml)).toEqual([
      { start: 0.24, text: "Jusqu'où peut-on" },
      { start: 65, text: "aller" },
    ]);
  });

  it("reads the legacy format, whose markup is escaped twice", () => {
    const xml =
      '<transcript><text start="1.5" dur="2">it&amp;#39;s</text><text start="3" dur="1">ok</text></transcript>';
    expect(parseCaptions(xml)).toEqual([
      { start: 1.5, text: "it's" },
      { start: 3, text: "ok" },
    ]);
  });
});

describe("transcriptMarkdown", () => {
  it("closes paragraphs at a sentence end once enough time has passed", () => {
    const md = transcriptMarkdown([
      { start: 0, text: "One." },
      { start: 10, text: "Two." },
      { start: 21, text: "Three." },
      { start: 30, text: "Four" },
      { start: 3700, text: "Late" },
    ]);
    expect(md).toBe("**0:00** · One. Two. Three.\n\n**0:30** · Four Late");
  });

  it("writes hours once past the first", () => {
    expect(transcriptMarkdown([{ start: 3725, text: "x" }])).toBe("**1:02:05** · x");
  });
});

describe("buildNote with a YouTube body", () => {
  it("writes the full description in the body and the transcript last", () => {
    const note = buildNote(
      {
        url: "https://www.youtube.com/watch?v=SeQXCpZhbjc",
        title: "T",
        description: "short…",
        author: "",
        published: "",
        media: [],
        body: "full\ndescription",
        transcript: "**0:00** · hi",
      },
      "2026-10-03"
    );
    expect(note).toContain('description: "short…"');
    expect(note).toContain("\nfull\ndescription\n");
    expect(note.trimEnd().endsWith("## Transcript\n\n**0:00** · hi")).toBe(true);
  });
});
