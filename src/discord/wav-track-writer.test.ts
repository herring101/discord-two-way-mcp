import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WavTrackWriter } from "./wav-track-writer.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WavTrackWriter", () => {
  test("writes a playable PCM WAV header and timeline silence", () => {
    const directory = mkdtempSync(join(tmpdir(), "discord-wav-test-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "track.wav");
    const writer = new WavTrackWriter(output, {
      sampleRate: 1_000,
      channels: 1,
      bitsPerSample: 16,
    });

    writer.appendPcmAt(Buffer.from([1, 0, 2, 0]), 10);
    writer.close(20);

    const wav = readFileSync(output);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(1_000);
    expect(wav.readUInt32LE(40)).toBe(40);
    expect(wav.length).toBe(84);
    expect([...wav.subarray(44, 64)]).toEqual(new Array(20).fill(0));
    expect([...wav.subarray(64, 68)]).toEqual([1, 0, 2, 0]);
  });
});
