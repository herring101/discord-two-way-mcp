import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const WAV_HEADER_BYTES = 44;
const MAX_UINT32 = 0xffff_ffff;
const SILENCE_CHUNK_BYTES = 64 * 1024;

export interface WavTrackWriterOptions {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  headerRefreshIntervalMs?: number;
}

export class WavTrackWriter {
  readonly path: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;

  private readonly fd: number;
  private readonly blockAlign: number;
  private readonly headerRefreshIntervalMs: number;
  private dataBytes = 0;
  private lastHeaderRefreshMs = 0;
  private closed = false;

  constructor(path: string, options: WavTrackWriterOptions = {}) {
    this.path = path;
    this.sampleRate = options.sampleRate ?? 48_000;
    this.channels = options.channels ?? 2;
    this.bitsPerSample = options.bitsPerSample ?? 16;
    this.headerRefreshIntervalMs = options.headerRefreshIntervalMs ?? 1_000;
    this.blockAlign = this.channels * Math.ceil(this.bitsPerSample / 8);

    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "w");
    writeSync(this.fd, this.createHeader(0), 0, WAV_HEADER_BYTES, 0);
  }

  get framesWritten(): number {
    return Math.floor(this.dataBytes / this.blockAlign);
  }

  appendPcmAt(pcm: Buffer, elapsedMs: number): void {
    this.ensureOpen();
    if (pcm.length % this.blockAlign !== 0) {
      throw new Error(
        `PCM chunk length ${pcm.length} is not aligned to ${this.blockAlign} bytes`,
      );
    }

    this.padTo(elapsedMs);
    this.writeData(pcm);
    this.refreshHeaderIfNeeded();
  }

  padTo(elapsedMs: number): void {
    this.ensureOpen();

    const targetFrames = Math.max(
      0,
      Math.floor((elapsedMs * this.sampleRate) / 1_000),
    );
    const missingBytes = Math.max(
      0,
      (targetFrames - this.framesWritten) * this.blockAlign,
    );
    if (missingBytes === 0) return;

    const silence = Buffer.alloc(Math.min(SILENCE_CHUNK_BYTES, missingBytes));
    let remaining = missingBytes;
    while (remaining > 0) {
      const length = Math.min(silence.length, remaining);
      this.writeData(silence.subarray(0, length));
      remaining -= length;
    }
  }

  close(finalElapsedMs?: number): void {
    if (this.closed) return;
    if (finalElapsedMs !== undefined) this.padTo(finalElapsedMs);

    this.writeHeader();
    closeSync(this.fd);
    this.closed = true;
  }

  private writeData(buffer: Buffer): void {
    if (this.dataBytes + buffer.length > MAX_UINT32 - 36) {
      throw new Error("WAV file exceeded the 4 GiB RIFF size limit");
    }

    writeSync(
      this.fd,
      buffer,
      0,
      buffer.length,
      WAV_HEADER_BYTES + this.dataBytes,
    );
    this.dataBytes += buffer.length;
  }

  private refreshHeaderIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastHeaderRefreshMs < this.headerRefreshIntervalMs) {
      return;
    }
    this.writeHeader();
    this.lastHeaderRefreshMs = now;
  }

  private writeHeader(): void {
    writeSync(
      this.fd,
      this.createHeader(this.dataBytes),
      0,
      WAV_HEADER_BYTES,
      0,
    );
  }

  private createHeader(dataBytes: number): Buffer {
    const header = Buffer.alloc(WAV_HEADER_BYTES);
    const bytesPerSample = Math.ceil(this.bitsPerSample / 8);
    const byteRate = this.sampleRate * this.channels * bytesPerSample;

    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(this.channels, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(this.blockAlign, 32);
    header.writeUInt16LE(this.bitsPerSample, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(dataBytes, 40);

    return header;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("Cannot write to a closed WAV track");
    }
  }
}
