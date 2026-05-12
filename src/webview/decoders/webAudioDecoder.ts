import { IAudioDecoder } from "./audioDecoderInterface";

export class WebAudioDecoder implements IAudioDecoder {
  private _data: Uint8Array;
  private _ext: string;
  private _audioBuffer: AudioBuffer | null = null;

  constructor(data: Uint8Array, ext: string) {
    this._data = data;
    this._ext = ext;
  }

  get numChannels() {
    return this._audioBuffer?.numberOfChannels ?? 0;
  }
  get sampleRate() {
    return this._audioBuffer?.sampleRate ?? 0;
  }
  get duration() {
    return this._audioBuffer?.duration ?? 0;
  }
  get length() {
    return this._audioBuffer?.length ?? 0;
  }
  get format() {
    return this._ext.toUpperCase();
  }
  get encoding() {
    return "PCM";
  }
  get fileSize() {
    return this._data.byteLength;
  }
  get samples(): Float32Array[] {
    if (!this._audioBuffer) {
      return [];
    }
    const result: Float32Array[] = [];
    for (let ch = 0; ch < this._audioBuffer.numberOfChannels; ch++) {
      result.push(this._audioBuffer.getChannelData(ch));
    }
    return result;
  }

  readAudioInfo() {
    // Info is only available after decoding; no-op here
  }

  decode() {
    // Actual decoding is async; use decodeAsync() externally
  }

  async decodeAsync(): Promise<void> {
    const ctx = new AudioContext();
    this._audioBuffer = await ctx.decodeAudioData(this._data.buffer.slice(0));
    await ctx.close();
  }

  dispose() {
    this._audioBuffer = null;
  }
}
