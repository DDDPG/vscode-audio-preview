import { IAudioDecoder } from "./audioDecoderInterface";
import { WasmDecoder, wasmDecoderSupports } from "./wasmDecoder";
import { WebAudioDecoder } from "./webAudioDecoder";

/**
 * Creates an appropriate audio decoder for the given file extension and data.
 *
 * Layer 1: wasm-audio-decoders (MP3, FLAC, Ogg Vorbis/Opus, raw Opus)
 * Layer 2: Web Audio API decodeAudioData (WAV, MP3, AAC — browser native)
 *
 * The returned decoder has already called decodeAsync(); callers may use
 * .samples, .sampleRate etc. directly without calling .decode() again.
 */
export async function createDecoder(
  data: Uint8Array,
  ext: string,
): Promise<IAudioDecoder> {
  const lowerExt = ext.toLowerCase().replace(/^\./, "");

  if (wasmDecoderSupports(lowerExt)) {
    const decoder = new WasmDecoder(data, lowerExt);
    try {
      await decoder.decodeAsync();
      return decoder;
    } catch {
      // fall through to Web Audio
    }
  }

  const decoder = new WebAudioDecoder(data, lowerExt);
  await decoder.decodeAsync();
  return decoder;
}
