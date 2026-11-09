/**
 * Reads a YouTube video's captions. The helper does this rather than the web
 * server because YouTube bot-checks the cloud addresses the deployed app runs
 * from, while a home connection is served the player normally.
 *
 * Nothing here touches a vault: the text is handed back to the browser, which
 * decides whether to keep it.
 */

import { PluginError } from "./sdk";

const WATCH_URL = "https://www.youtube.com/watch";
const PLAYER_API = "https://www.youtube.com/youtubei/v1/player";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/**
 * The Android client the transcript tools ask as. The web client is bot
 * checked and answers an unplayable video, while its transcript endpoint
 * refuses the request; this one still serves the caption track URLs.
 */
const CLIENT = { clientName: "ANDROID", clientVersion: "20.10.38" };
const TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_TRACK_BYTES = 4_000_000;
/** Captions arrive in short cues; lines are grouped up to this many seconds. */
const LINE_SECONDS = 12;
/** Or this many characters, so a fast speaker does not make a wall of text. */
const LINE_CHARS = 220;
const MAX_CHARS = 200_000;
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

export type TranscriptCue = {
  seconds: number;
  text: string;
};

type CaptionTrack = {
  baseUrl: string;
  languageCode: string;
  kind: string | null;
};

type PlayerPayload = {
  playabilityStatus?: { status?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: { captionTracks?: unknown };
  };
};

/** A transcript could not be read, for a reason the browser can show. */
export class TranscriptError extends Error {
  constructor(
    readonly code: "NOT_YOUTUBE" | "NO_TRANSCRIPT" | "REFUSED",
    message: string,
  ) {
    super(message);
    this.name = "TranscriptError";
  }
}

/** The video id of a YouTube link, or null when it is not one. */
export function youtubeVideoId(url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean);

  if (/(^|\.)youtu\.be$/i.test(url.hostname)) {
    const id = segments[0];
    return id && VIDEO_ID.test(id) ? id : null;
  }
  if (!/(^|\.)youtube\.com$/i.test(url.hostname)) {
    return null;
  }

  if (segments[0] === "watch") {
    const id = url.searchParams.get("v");
    return id && VIDEO_ID.test(id) ? id : null;
  }

  const prefix = segments[0];
  if (prefix === "shorts" || prefix === "embed" || prefix === "live") {
    const id = segments[1];
    return id && VIDEO_ID.test(id) ? id : null;
  }

  return null;
}

function clean(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (whole, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return NAMED[body.toLowerCase()] ?? whole;
    },
  );
}

/** Drops the rolling repeats auto captions carry, which are not new speech. */
function uniqueCues(cues: TranscriptCue[]): TranscriptCue[] {
  const seen = new Set<string>();
  return cues.filter((cue) => {
    if (seen.has(cue.text)) {
      return false;
    }
    seen.add(cue.text);
    return true;
  });
}

/** The `json3` caption format: events carrying their start time and text. */
function parseJson3(body: string): TranscriptCue[] | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }

  const events = (data as { events?: unknown }).events;
  if (!Array.isArray(events)) {
    return null;
  }

  const cues: TranscriptCue[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null) {
      continue;
    }
    const item = event as {
      tStartMs?: unknown;
      segs?: Array<{ utf8?: unknown }>;
    };
    const text = clean(
      (item.segs ?? [])
        .map((segment) =>
          typeof segment.utf8 === "string" ? segment.utf8 : "",
        )
        .join(""),
    );
    if (!text) {
      continue;
    }
    const start = typeof item.tStartMs === "number" ? item.tStartMs : 0;
    cues.push({ seconds: Math.max(0, Math.round(start / 1000)), text });
  }
  return cues;
}

/** The `srv1` caption format: one `<text start="seconds">` per cue. */
const TEXT_TAG = /<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
/** The `srv3` format: `<p t="milliseconds">` paragraphs of `<s>` spans. */
const PARAGRAPH_TAG = /<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;

function xmlCues(body: string): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  for (const match of body.matchAll(TEXT_TAG)) {
    const text = clean(match[2]);
    if (text) {
      cues.push({
        seconds: Math.max(0, Math.round(Number(match[1]) || 0)),
        text,
      });
    }
  }
  if (cues.length > 0) {
    return cues;
  }
  for (const match of body.matchAll(PARAGRAPH_TAG)) {
    const text = clean(match[2]);
    if (text) {
      cues.push({
        seconds: Math.max(0, Math.round((Number(match[1]) || 0) / 1000)),
        text,
      });
    }
  }
  return cues;
}

/** The cues of a caption document, in either format the host serves. */
export function parseTranscript(body: string): TranscriptCue[] {
  return uniqueCues(parseJson3(body) ?? xmlCues(body));
}

/** The caption tracks a player response offers, if the video has any. */
export function playerCaptionTracks(payload: unknown): CaptionTrack[] {
  const tracks = (payload as PlayerPayload | null)?.captions
    ?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks)) {
    return [];
  }

  return tracks.flatMap((track) => {
    if (typeof track !== "object" || track === null) {
      return [];
    }
    const entry = track as Record<string, unknown>;
    const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl : "";
    if (!baseUrl) {
      return [];
    }
    return [
      {
        baseUrl,
        languageCode:
          typeof entry.languageCode === "string" ? entry.languageCode : "",
        kind: typeof entry.kind === "string" ? entry.kind : null,
      },
    ];
  });
}

/**
 * The track to read: a written English track first, then a written track in
 * any language, then auto captions, which are the least accurate.
 */
export function pickCaptionTrack(
  tracks: CaptionTrack[],
  language?: string,
  autoGenerated = true,
): CaptionTrack | null {
  const wanted = language?.trim().toLowerCase();
  const spoken = autoGenerated
    ? tracks
    : tracks.filter((track) => track.kind !== "asr");
  const written = spoken.filter((track) => track.kind !== "asr");
  const preferred = wanted
    ? spoken.find((track) => track.languageCode.toLowerCase().startsWith(wanted))
    : undefined;

  return (
    preferred ??
    written.find((track) => track.languageCode.startsWith("en")) ??
    written[0] ??
    spoken.find((track) => track.languageCode.startsWith("en")) ??
    spoken[0] ??
    null
  );
}

async function readCapped(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value || value.byteLength === 0) {
      continue;
    }
    const room = limit - total;
    if (value.byteLength >= room) {
      if (room > 0) {
        chunks.push(value.slice(0, room));
        total = limit;
      }
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.subarray(0, offset);
}

function stamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** Reads the cues as timed lines, so a transcript can be scanned and cited. */
export function formatTranscript(cues: TranscriptCue[]): string {
  const lines: string[] = [];
  let total = 0;
  let start = -1;
  let length = 0;
  let parts: string[] = [];

  const flush = () => {
    const text = parts.join(" ").trim();
    if (text) {
      const line = `[${stamp(Math.max(0, start))}] ${text}`;
      lines.push(line);
      total += line.length + 1;
    }
    parts = [];
    length = 0;
    start = -1;
  };

  for (const cue of cues) {
    if (total >= MAX_CHARS) {
      break;
    }
    // Close the line before a cue that would run past it, so a timestamp always
    // starts the text under it.
    if (
      start >= 0 &&
      (length >= LINE_CHARS || cue.seconds - start >= LINE_SECONDS)
    ) {
      flush();
    }
    if (start < 0) {
      start = cue.seconds;
    }
    parts.push(cue.text);
    length += cue.text.length;
  }
  flush();

  const text = lines.join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
}

/** The API key the page was served with, which the player call needs. */
function innertubeKey(html: string): string | null {
  return html.match(/"INNERTUBE_API_KEY":\s*"([A-Za-z0-9_-]+)"/)?.[1] ?? null;
}

/**
 * Some pages carry the caption tracks in their own JSON, which makes the
 * player call unnecessary when it is the part being refused.
 */
function pageCaptionTracks(html: string): CaptionTrack[] {
  const raw = /"captionTracks":(\[.*?\])/.exec(html)?.[1];
  if (!raw) {
    return [];
  }
  try {
    return playerCaptionTracks({ captions: { playerCaptionsTracklistRenderer: { captionTracks: JSON.parse(raw) } } });
  } catch {
    return [];
  }
}

/** Reads one caption document, or null when it would not be served. */
async function readCaptions(url: string): Promise<string | null> {
  const response = await fetch(url, {
    headers: {
      "user-agent": BROWSER_USER_AGENT,
      accept: "*/*",
      "accept-language": "en",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = new TextDecoder().decode(
    await readCapped(response, MAX_TRACK_BYTES),
  );
  return body || null;
}

/** The cues of a track: the JSON format, then the XML one it defaults to. */
async function trackCues(baseUrl: string): Promise<TranscriptCue[]> {
  // The URL names its own format; asking for json3 is the smallest answer to
  // parse, and the default `srv1`/`srv3` is the fallback.
  const plain = baseUrl
    .replace(/([&?])fmt=[^&]*/g, "$1")
    .replace(/[?&]$/, "");
  const json = await readCaptions(`${plain}&fmt=json3`);
  const fromJson = json ? uniqueCues(parseJson3(json) ?? []) : [];
  if (fromJson.length > 0) {
    return fromJson;
  }

  const xml = await readCaptions(plain);
  return xml ? uniqueCues(xmlCues(xml)) : [];
}

/** Asks the player endpoint for the video, as the Android client. */
async function playerPayload(
  videoId: string,
  apiKey: string,
): Promise<PlayerPayload | null> {
  const response = await fetch(
    `${PLAYER_API}?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": BROWSER_USER_AGENT,
        "accept-language": "en-US",
      },
      body: JSON.stringify({ context: { client: CLIENT }, videoId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  ).catch(() => null);

  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined);
    return null;
  }

  const text = new TextDecoder().decode(
    await readCapped(response, MAX_TRACK_BYTES),
  );
  try {
    return JSON.parse(text) as PlayerPayload;
  } catch {
    return null;
  }
}

/**
 * The transcript of a YouTube link, as timed lines. Throws `TranscriptError`
 * when the link is not a video, the video has no captions, or YouTube refused
 * the helper (a bot check rather than a missing transcript).
 */
export type TranscriptOptions = {
  /** A caption language to prefer; falls back to English, then any track. */
  language?: string;
  /** A video with only auto captions answers `no_data` when this is false. */
  autoGenerated?: boolean;
  /** Trims the formatted lines; 0 keeps them all. */
  maxLines?: number;
};

export async function fetchTranscriptForUrl(
  url: URL,
  options: TranscriptOptions = {},
): Promise<string> {
  const videoId = youtubeVideoId(url);
  if (!videoId) {
    throw new TranscriptError("NOT_YOUTUBE", "This link is not a YouTube video.");
  }

  const page = await fetch(`${WATCH_URL}?v=${videoId}`, {
    headers: {
      "user-agent": BROWSER_USER_AGENT,
      accept: "text/html",
      "accept-language": "en",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!page?.ok) {
    await page?.body?.cancel().catch(() => undefined);
    throw new TranscriptError(
      "REFUSED",
      "YouTube did not return this transcript. Try again later.",
    );
  }

  const html = new TextDecoder().decode(
    await readCapped(page, MAX_PAGE_BYTES),
  );
  // A captcha instead of the page means this machine is being held at the door.
  if (html.includes('class="g-recaptcha"')) {
    throw new TranscriptError(
      "REFUSED",
      "YouTube did not return this transcript. Try again later.",
    );
  }

  const key = innertubeKey(html);
  const payload = key
    ? await playerPayload(videoId, key).catch(() => null)
    : null;
  const status = payload?.playabilityStatus?.status;
  const playable = Boolean(payload) && (!status || status === "OK");

  let tracks = playerCaptionTracks(payload);
  if (tracks.length === 0) {
    // Some pages carry the tracks in their own JSON, which rescues a video
    // whose player call alone was held at the door.
    tracks = pageCaptionTracks(html);
  }

  const track = pickCaptionTrack(
    tracks,
    options.language,
    options.autoGenerated ?? true,
  );
  if (!track) {
    throw playable
      ? new TranscriptError(
          "NO_TRANSCRIPT",
          "YouTube has no transcript for this video.",
        )
      : new TranscriptError(
          "REFUSED",
          "YouTube did not return this transcript. Try again later.",
        );
  }

  const cues = await trackCues(track.baseUrl).catch(() => []);
  const text = formatTranscript(cues);
  if (!text) {
    throw new TranscriptError(
      "REFUSED",
      "YouTube did not return this transcript. Try again later.",
    );
  }

  const limit = options.maxLines ?? 0;
  return limit > 0
    ? text.split("\n").slice(0, limit).join("\n")
    : text;
}

/** One video's transcript, with the plugin's error codes. */
export async function readTranscript(
  url: string,
  options: TranscriptOptions = {},
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PluginError("bad_subject", "That link is not a web address.");
  }

  try {
    return await fetchTranscriptForUrl(parsed, options);
  } catch (error) {
    if (error instanceof TranscriptError) {
      throw new PluginError(
        error.code === "NO_TRANSCRIPT"
          ? "no_data"
          : error.code === "NOT_YOUTUBE"
            ? "bad_subject"
            : "refused",
        error.message,
      );
    }
    throw error;
  }
}
