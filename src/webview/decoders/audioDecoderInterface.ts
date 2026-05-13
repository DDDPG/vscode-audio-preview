export interface IAudioDecoder {
  readonly numChannels: number;
  readonly sampleRate: number;
  readonly duration: number;
  readonly length: number;
  readonly format: string;
  readonly encoding: string;
  /** Stored PCM depth from container when known (WAV / FLAC); null for opaque decode (e.g. MP3). */
  readonly bitDepth: number | null;
  readonly fileSize: number;
  readonly samples: Float32Array[];
  readAudioInfo(): void;
  decode(): void;
  dispose(): void;
}
