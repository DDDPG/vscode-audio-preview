export interface IAudioDecoder {
  readonly numChannels: number;
  readonly sampleRate: number;
  readonly duration: number;
  readonly length: number;
  readonly format: string;
  readonly encoding: string;
  readonly fileSize: number;
  readonly samples: Float32Array[];
  readAudioInfo(): void;
  decode(): void;
  dispose(): void;
}
