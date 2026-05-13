import {
  parseFlacBitsPerSample,
  parseWavBitsPerSample,
} from "./audioFileBitDepth";

/** Minimal RIFF/WAVE with 24-bit PCM `fmt` then empty `data` chunk. */
function minimalWav24(): Uint8Array {
  const u8 = new Uint8Array(44);
  const dv = new DataView(u8.buffer);
  dv.setUint32(0, 0x46464952, true); // RIFF
  dv.setUint32(4, 36, true); // size - 8
  dv.setUint32(8, 0x57415645, true); // WAVE
  dv.setUint32(12, 0x20746d66, true); // 'fmt '
  dv.setUint32(16, 16, true); // fmt body size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, 44100, true);
  dv.setUint32(28, 44100 * 3, true); // byte rate (24-bit)
  dv.setUint16(32, 3, true); // block align
  dv.setUint16(34, 24, true); // bits per sample
  dv.setUint32(36, 0x61746164, true); // 'data'
  dv.setUint32(40, 0, true);
  return u8;
}

describe("audioFileBitDepth", () => {
  test("parseWavBitsPerSample reads wBitsPerSample", () => {
    expect(parseWavBitsPerSample(minimalWav24())).toBe(24);
  });

  test("parseWavBitsPerSample returns null for non-RIFF", () => {
    expect(parseWavBitsPerSample(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  test("parseFlacBitsPerSample returns null for non-FLAC", () => {
    expect(parseFlacBitsPerSample(minimalWav24())).toBeNull();
  });
});
