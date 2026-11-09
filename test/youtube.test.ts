import { describe, expect, test } from "bun:test";

import {
  formatTranscript,
  parseTranscript,
  pickCaptionTrack,
  playerCaptionTracks,
  youtubeVideoId,
} from "../src/youtube";

function url(value: string): URL {
  return new URL(value);
}

describe("transcript video ids", () => {
  test("reads watch, short and short-link addresses", () => {
    expect(youtubeVideoId(url("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))).toBe(
      "dQw4w9WgXcQ",
    );
    expect(youtubeVideoId(url("https://youtu.be/dQw4w9WgXcQ"))).toBe(
      "dQw4w9WgXcQ",
    );
    expect(youtubeVideoId(url("https://www.youtube.com/shorts/abc123XYZ"))).toBe(
      "abc123XYZ",
    );
    expect(youtubeVideoId(url("https://m.youtube.com/embed/dQw4w9WgXcQ"))).toBe(
      "dQw4w9WgXcQ",
    );
  });

  test("refuses anything that is not a video", () => {
    expect(youtubeVideoId(url("https://example.com/watch?v=dQw4w9WgXcQ"))).toBeNull();
    expect(youtubeVideoId(url("https://www.youtube.com/channel/abc"))).toBeNull();
    expect(youtubeVideoId(url("https://www.youtube.com/watch?v=short"))).toBeNull();
  });
});

describe("transcript parsing", () => {
  test("reads the json3 events", () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: "Hello " }, { utf8: "there" }] },
        { tStartMs: 4000, segs: [{ utf8: "Again" }] },
        { tStartMs: 5000, segs: [{ utf8: "Hello there" }] },
        { tStartMs: 6000, segs: [{ utf8: "\n" }] },
      ],
    });

    expect(parseTranscript(body)).toEqual([
      { seconds: 0, text: "Hello there" },
      { seconds: 4, text: "Again" },
    ]);
  });

  test("falls back to the XML documents", () => {
    const body = `<transcript><text start="3.5" dur="2">A &amp; B</text><text start="9">Next</text></transcript>`;

    expect(parseTranscript(body)).toEqual([
      { seconds: 4, text: "A & B" },
      { seconds: 9, text: "Next" },
    ]);
  });
});

describe("transcript tracks", () => {
  test("prefers a written English track over auto captions", () => {
    const tracks = playerCaptionTracks({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: "b", languageCode: "de", kind: "asr" },
            { baseUrl: "a", languageCode: "en", kind: "asr" },
            { baseUrl: "c", languageCode: "en" },
          ],
        },
      },
    });

    expect(pickCaptionTrack(tracks)?.baseUrl).toBe("c");
  });
});

describe("transcript formatting", () => {
  test("writes each line with its timestamp", () => {
    const text = formatTranscript([
      { seconds: 0, text: "First" },
      { seconds: 4, text: "Second" },
      { seconds: 120, text: "Later" },
    ]);

    expect(text).toBe("[00:00] First Second\n[02:00] Later");
  });
});
