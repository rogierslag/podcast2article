import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function checkMedia(releaseDirectory, expectedFfmpeg) {
  const require = createRequire(path.join(releaseDirectory, "package.json"));
  const ffmpeg = require("ffmpeg-static");
  if (!ffmpeg) {
    throw new Error("No FFmpeg executable is configured");
  }
  if (expectedFfmpeg && ffmpeg !== expectedFfmpeg) {
    throw new Error(
      "Another service override supersedes the requested FFmpeg selection",
    );
  }
  const { normalizeAudio, splitAudio } = await import(
    pathToFileURL(path.join(releaseDirectory, "dist/services/audio.js"))
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), "p2a-media-smoke-"));
  const signal = AbortSignal.timeout(60_000);
  try {
    const input = path.join(directory, "source.media");
    const remuxed = path.join(directory, "remuxed.mp4");
    const audio = path.join(directory, "playback.mp3");
    // Exercise the MPEG-TS demuxer and MP4 remuxer that failed in production.
    await execute(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        "2",
        "-c:a",
        "aac",
        "-f",
        "mpegts",
        input,
      ],
      { signal },
    );
    await execute(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        input,
        "-map",
        "0",
        "-dn",
        "-ignore_unknown",
        "-c",
        "copy",
        "-f",
        "mp4",
        "-movflags",
        "+faststart",
        remuxed,
      ],
      { signal },
    );
    await normalizeAudio(remuxed, audio, signal);
    const chunksDirectory = path.join(directory, "chunks");
    await mkdir(chunksDirectory);
    const chunks = await splitAudio(audio, chunksDirectory, signal);
    if (!(await stat(audio)).size || !chunks.length) {
      throw new Error("Media smoke test produced no audio");
    }
    for (const chunk of chunks) {
      if (!(await stat(chunk)).size) {
        throw new Error("Media smoke test produced an empty chunk");
      }
      // Decode the final artifact as well; a nonempty file alone is insufficient.
      await execute(
        ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-i",
          chunk,
          "-f",
          "null",
          "-",
        ],
        { signal },
      );
    }
    console.log(
      "Media smoke test passed: MPEG-TS → MP4 → MP3 → playable chunks",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await checkMedia(path.resolve(process.argv[2] ?? "."), process.argv[3]);
  } catch {
    // Never print arbitrary subprocess output, environment, or source metadata.
    console.error(
      "Media smoke test failed; check the configured FFmpeg installation.",
    );
    process.exitCode = 1;
  }
}
