import { afterEach, describe, expect, it } from "vitest";
import { audioChunkSeconds, audioSplitArguments } from "./audio.js";

const original = process.env.AUDIO_CHUNK_SECONDS;

afterEach(() => {
  if (original === undefined) {
    delete process.env.AUDIO_CHUNK_SECONDS;
  } else {
    process.env.AUDIO_CHUNK_SECONDS = original;
  }
});

describe("audio chunk duration", () => {
  it("defaults to five-minute chunks", () => {
    delete process.env.AUDIO_CHUNK_SECONDS;
    expect(audioChunkSeconds()).toBe(300);
  });

  it("accepts a configured duration", () => {
    process.env.AUDIO_CHUNK_SECONDS = "180";
    expect(audioChunkSeconds()).toBe(180);
  });

  it("keeps values within safe limits", () => {
    process.env.AUDIO_CHUNK_SECONDS = "10";
    expect(audioChunkSeconds()).toBe(60);
    process.env.AUDIO_CHUNK_SECONDS = "5000";
    expect(audioChunkSeconds()).toBe(1200);
  });
});

describe("audio chunking", () => {
  it("copies the normalized MP3 stream without encoding it again", () => {
    const arguments_ = audioSplitArguments(
      "playback.mp3",
      "chunk-%03d.mp3",
      300,
    );
    expect(arguments_).toContain("copy");
    expect(arguments_).toContain("0:a:0");
    expect(arguments_).not.toContain("48k");
    expect(arguments_).not.toContain("16000");
  });
});
